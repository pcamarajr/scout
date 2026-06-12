import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveStorageState, type ScoutConfig } from "./config.js";
import { renderRunReport } from "./report.js";
import { Store } from "./store.js";
import { BrowserSession } from "./runner/browser.js";
import { runWithAgent } from "./runner/ai-runner.js";
import { describeStep, replaySteps } from "./runner/script-runner.js";
import type { RunResult, Scenario, Step, Target } from "./types.js";

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

/**
 * Runs `attempt` until it produces a real verdict, retrying runner failures
 * (agent died without calling scout_verdict) up to maxAttempts total runs.
 * A verdict — even failed/blocked — is the agent's judgment and is never retried.
 */
export async function runAiWithRetry<T extends { runnerFailure?: string }>(
  attempt: (attemptNo: number) => Promise<T>,
  maxAttempts = 2
): Promise<{ outcome: T; attempts: number }> {
  let outcome!: T;
  for (let i = 1; i <= maxAttempts; i++) {
    outcome = await attempt(i);
    if (!outcome.runnerFailure) return { outcome, attempts: i };
  }
  return { outcome, attempts: maxAttempts };
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
  const transcript: string[] = [];
  const screenshots: string[] = [];
  let trace: string | undefined;

  const { outcome, attempts } = await runAiWithRetry(async (attemptNo) => {
    if (attemptNo > 1) transcript.push(`[scout] Tentativa ${attemptNo}: run anterior falhou no runner — browser novo, agente novo.`);
    const session = await BrowserSession.launch({
      baseUrl: config.baseUrl,
      headless: opts.headed ? false : config.headless,
      storageState,
      locale: config.locale,
      runDir,
    });
    let result;
    try {
      result = await runWithAgent(session, scenario, config);
    } finally {
      await session.screenshot("final-state").catch(() => {});
    }
    trace = await session.close();
    transcript.push(...result.transcript);
    for (const shot of session.screenshots) if (!screenshots.includes(shot)) screenshots.push(shot);
    return result;
  });

  fs.writeFileSync(path.join(runDir, "transcript.md"), transcript.join("\n\n---\n\n"));

  if (outcome.verdict === "verified" && outcome.steps.length) {
    store.saveSteps(scenario.slug, pruneSteps(outcome.steps));
  }

  return {
    scenarioId: scenario.id,
    slug: scenario.slug,
    mode: "ai",
    verdict: outcome.verdict,
    reason: outcome.runnerFailure
      ? `${outcome.reason} (${attempts} tentativas de AI run — investigue os artifacts em ${runDir})`
      : outcome.reason,
    stepCount: outcome.steps.length,
    runDir,
    startedAt,
    durationMs: Date.now() - start,
    screenshots,
    trace,
    runnerFailure: outcome.runnerFailure,
  };
}

/** Steps that can sit between two fills of the same field without consuming its value. */
const INERT_BETWEEN_FILLS = new Set<Step["kind"]>([
  "waitForText",
  "waitForUrl",
  "assertVisible",
  "assertNotVisible",
  "assertUrl",
  "screenshot",
]);

function targetKey(target: Target): string {
  return JSON.stringify([target.role ?? null, target.name ?? null, target.css ?? null]);
}

/**
 * Cleans the recorded trace before caching. The agent sometimes retries an
 * input (e.g. re-fills the password field) — the earlier fill is redundant
 * noise in the replay script, since Playwright's fill() replaces the value.
 *
 * Conservative by design: an earlier `fill`/`select` is dropped only when a
 * later one targets the SAME element and nothing in between could have
 * consumed the value — fills on other fields and passive steps (waits,
 * asserts, screenshots) are inert; any `click`, `press`, `select` (other
 * target) or `navigate` blocks the dedupe. Clicks are never deduplicated.
 */
export function pruneSteps(steps: Step[]): Step[] {
  const drop = new Set<number>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.kind !== "fill" && step.kind !== "select") continue;
    for (let j = i + 1; j < steps.length; j++) {
      const later = steps[j];
      if (later.kind === step.kind && targetKey(later.target) === targetKey(step.target)) {
        drop.add(i); // only the last value matters
        break;
      }
      // fill on a different field doesn't consume this one's value
      if (later.kind === "fill") continue;
      if (INERT_BETWEEN_FILLS.has(later.kind)) continue;
      break; // click/press/select/navigate may have consumed the value — keep both
    }
  }
  return drop.size ? steps.filter((_, i) => !drop.has(i)) : steps;
}

export { describeStep };
