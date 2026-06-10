import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveStorageState, type ScoutConfig } from "./config.js";
import { renderRunReport } from "./report.js";
import { Store } from "./store.js";
import { BrowserSession } from "./runner/browser.js";
import { runWithAgent } from "./runner/ai-runner.js";
import { describeStep, replaySteps } from "./runner/script-runner.js";
import type { RunResult, Scenario, Step } from "./types.js";

export interface RunOptions {
  /** Skip the cached script and force an AI run (re-record) */
  forceAi?: boolean;
  /** When the cached script fails, re-verify with the AI agent (default true) */
  heal?: boolean;
  headed?: boolean;
}

function aiAvailable(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      fs.existsSync(path.join(process.env.HOME ?? "", ".claude"))
  );
}

/**
 * Core run logic shared by CLI and MCP server:
 *   cached script exists?  → replay (no LLM)
 *     → pass               → verified
 *     → fail + heal        → AI run; if verified, re-record the script
 *   no script / --ai       → AI run; if verified, record the script
 */
export async function runScenario(
  store: Store,
  scenario: Scenario,
  config: ScoutConfig = loadConfig(),
  opts: RunOptions = {}
): Promise<RunResult> {
  const heal = opts.heal ?? true;
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const runDir = store.newRunDir(scenario.slug);
  const storageState = resolveStorageState(scenario.profile, config);
  const cached = opts.forceAi ? undefined : store.loadSteps(scenario.slug);

  const launch = () =>
    BrowserSession.launch({
      baseUrl: config.baseUrl,
      headless: opts.headed ? false : config.headless,
      storageState,
      locale: config.locale,
      runDir,
    });

  let result: RunResult;

  if (cached?.length) {
    const session = await launch();
    const replay = await replaySteps(session, cached);
    const trace = await session.close();

    if (replay.passed) {
      result = {
        scenarioId: scenario.id,
        slug: scenario.slug,
        mode: "replay",
        verdict: "verified",
        reason: `Deterministic script passed (${cached.length} steps).`,
        stepCount: cached.length,
        runDir,
        startedAt,
        durationMs: Date.now() - start,
        screenshots: session.screenshots,
        trace,
      };
    } else if (heal && aiAvailable()) {
      // cached script broke — re-verify with the agent and re-record
      const aiResult = await runAi(scenario, config, store, runDir, storageState, opts);
      result = {
        ...aiResult,
        healed: true,
        reason: `Cached script broke at step ${replay.failedIndex! + 1} (${replay.failedStep}: ${replay.error}). Re-verified by AI: ${aiResult.reason}`,
        startedAt,
        durationMs: Date.now() - start,
      };
    } else {
      result = {
        scenarioId: scenario.id,
        slug: scenario.slug,
        mode: "replay",
        verdict: "failed",
        reason: `Step ${replay.failedIndex! + 1} failed: ${replay.failedStep} — ${replay.error}${heal ? " (AI heal unavailable: no Anthropic credentials)" : " (heal disabled)"}`,
        stepCount: cached.length,
        failedStep: replay.failedStep,
        runDir,
        startedAt,
        durationMs: Date.now() - start,
        screenshots: session.screenshots,
        trace,
      };
    }
  } else {
    if (!aiAvailable()) {
      throw new Error(
        `Scenario "${scenario.slug}" has no recorded script and no Anthropic credentials (ANTHROPIC_API_KEY) for the initial AI run.`
      );
    }
    const aiResult = await runAi(scenario, config, store, runDir, storageState, opts);
    result = { ...aiResult, startedAt, durationMs: Date.now() - start };
  }

  store.saveRunResult(result);
  store.updateScenario(scenario.id, { status: result.verdict, lastRun: result.startedAt });
  fs.writeFileSync(
    path.join(runDir, "report.md"),
    renderRunReport(result, scenario, store.loadSteps(scenario.slug))
  );
  return result;
}

async function runAi(
  scenario: Scenario,
  config: ScoutConfig,
  store: Store,
  runDir: string,
  storageState: string | undefined,
  opts: RunOptions
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const session = await BrowserSession.launch({
    baseUrl: config.baseUrl,
    headless: opts.headed ? false : config.headless,
    storageState,
    locale: config.locale,
    runDir,
  });

  let outcome;
  try {
    outcome = await runWithAgent(session, scenario, config);
  } finally {
    await session.screenshot("final-state").catch(() => {});
  }
  const trace = await session.close();

  fs.writeFileSync(path.join(runDir, "transcript.md"), outcome.transcript.join("\n\n---\n\n"));

  if (outcome.verdict === "verified" && outcome.steps.length) {
    store.saveSteps(scenario.slug, pruneSteps(outcome.steps));
  }

  return {
    scenarioId: scenario.id,
    slug: scenario.slug,
    mode: "ai",
    verdict: outcome.verdict,
    reason: outcome.reason,
    stepCount: outcome.steps.length,
    runDir,
    startedAt,
    durationMs: Date.now() - start,
    screenshots: session.screenshots,
    trace,
  };
}

/**
 * Cleans the recorded trace before caching: drops exploratory snapshots the
 * agent took that produced no action (they're not steps) — currently steps
 * are only recorded on success, so this is a hook for future pruning rules.
 */
function pruneSteps(steps: Step[]): Step[] {
  return steps;
}

export { describeStep };
