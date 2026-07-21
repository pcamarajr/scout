import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveCookies, resolveStorage, resolveStorageState, type ScoutConfig } from "./config.js";
import { detectAiCredentials, inferProvider } from "./credentials.js";
import { renderRunReport } from "./report.js";
import { Store } from "./store.js";
import { BrowserSession } from "./runner/browser.js";
import { runWithAgent } from "./runner/ai-runner.js";
import { describeStep, replayForDemo, replaySteps } from "./runner/script-runner.js";
import { collectFragileSteps } from "./runner/selector-ladder.js";
import { generateVideo, pacingFor, type TimelineEntry, type VideoPacing } from "./runner/video.js";
import { defaultViewportName, resolveViewport, type ResolvedViewport } from "./viewports.js";
import type { RunResult, Scenario, ScenarioCookie, ScenarioStorage, Step, Target } from "./types.js";

export interface RunOptions {
  /** Skip the cached script and force an AI run (re-record) */
  forceAi?: boolean;
  /** When the cached script fails, re-verify with the AI agent (default true) */
  heal?: boolean;
  headed?: boolean;
  /** Viewport name to run in. Omitted = the config's default viewport. */
  viewport?: string;
  /**
   * Ad-hoc run (the `--viewport` override): verify but never persist a cached
   * script, so a forced viewport the scenario doesn't declare leaves no orphan
   * `<slug>@<viewport>.json` behind.
   */
  ephemeral?: boolean;
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
  const viewportName = opts.viewport ?? defaultViewportName(config);
  const viewport = resolveViewport(viewportName, config);
  const ephemeral = opts.ephemeral ?? false;
  const runDir = store.newRunDir(scenario.slug, viewportName);
  const storageState = resolveStorageState(scenario.profile, config);
  const cookies = resolveCookies(scenario, config);
  const storage = resolveStorage(scenario, config);
  const cached = opts.forceAi ? undefined : store.loadSteps(scenario.slug, viewportName);
  const aiCreds = detectAiCredentials(inferProvider(config.model), { engine: config.engine });

  const launch = () =>
    BrowserSession.launch({
      baseUrl: config.baseUrl,
      headless: opts.headed ? false : config.headless,
      storageState,
      locale: config.locale,
      runDir,
      viewport,
      permissions: scenario.permissions,
      cookies,
      storage,
      extraHeaders: config.headers,
      testIdAttribute: config.testIdAttribute,
    });

  let result: RunResult;
  // Steps that actually verified this run, for sourcing the demo video. An
  // ephemeral run (--viewport override) never persists a script, so the demo
  // can't re-read it from the store — it films these instead.
  let verifiedSteps: Step[] | undefined;

  if (cached?.length) {
    const session = await launch();
    const replay = await replaySteps(session, cached);
    const { trace } = await session.close();

    if (replay.passed) {
      verifiedSteps = cached;
      result = {
        slug: scenario.slug,
        viewport: viewportName,
        mode: "replay",
        verdict: "verified",
        reason: `Deterministic script passed (${cached.length} steps).`,
        stepCount: cached.length,
        runDir,
        startedAt,
        durationMs: Date.now() - start,
        screenshots: session.screenshots,
        trace,
        ...(replay.fallbacks?.length ? { usedFallbacks: replay.fallbacks } : {}),
      };
    } else if (heal && aiCreds.ok) {
      // cached script broke — re-verify with the agent and re-record
      const ai = await runAi(scenario, config, store, runDir, viewport, storageState, cookies, storage, opts);
      verifiedSteps = ai.steps;
      result = {
        ...ai.result,
        healed: true,
        reason: `Cached script broke at step ${replay.failedIndex! + 1} (${replay.failedStep}: ${replay.error}). Re-verified by AI: ${ai.result.reason}`,
        startedAt,
        durationMs: Date.now() - start,
      };
    } else {
      result = {
        slug: scenario.slug,
        viewport: viewportName,
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
        ...(replay.fallbacks?.length ? { usedFallbacks: replay.fallbacks } : {}),
      };
    }
  } else {
    if (!aiCreds.ok) {
      throw new Error(aiCreds.remediation);
    }
    const ai = await runAi(scenario, config, store, runDir, viewport, storageState, cookies, storage, opts);
    verifiedSteps = ai.steps;
    result = { ...ai.result, startedAt, durationMs: Date.now() - start };
  }

  // Demo video: always sourced from a dedicated clean replay of the recorded
  // script (never the AI run), only when verified and opted-in. The committed
  // script wins; an ephemeral --viewport run persists none, so fall back to the
  // steps this run just verified (pruned the same way a committed script is).
  if (config.recordVideo && result.verdict === "verified") {
    const persisted = store.loadSteps(scenario.slug, viewportName);
    const steps = persisted ?? (verifiedSteps ? pruneSteps(verifiedSteps) : undefined);
    if (steps?.length) {
      result.video = await recordDemoVideo(scenario, steps, config, viewport, storageState, cookies, storage, runDir);
    }
  }

  // Surface fragility from the FINAL recorded script (persisted or, for an
  // ephemeral run, just-verified) so a positional selector is flagged at record
  // time — not discovered on a broken replay later.
  const finalSteps = store.loadSteps(scenario.slug, viewportName) ?? verifiedSteps;
  const fragile = finalSteps ? collectFragileSteps(finalSteps) : [];
  if (fragile.length) result.fragileSteps = fragile;

  store.saveRunResult(result);
  fs.writeFileSync(
    path.join(runDir, "report.md"),
    renderRunReport(result, scenario, finalSteps)
  );
  return result;
}

/** A single recorded replay attempt: the WebM it produced and whether it passed. */
export interface RecordedReplay {
  passed: boolean;
  /** Path to the recorded WebM, if the context produced one. */
  webm?: string;
  /** Step captions with wall-clock offsets, for burned overlays. */
  timeline: TimelineEntry[];
  /** Human-readable "step N (description): error" when the replay tripped. */
  failure?: string;
}

/**
 * Builds the pacing for the non-paced fallback replay: zero slowMo, dwell and
 * cursor-travel so it mirrors the authoritative `ai+heal` replay (which passed).
 * The title/verdict card durations are kept so the rendered MP4 still bookends
 * with the scenario name and the VERIFIED card.
 */
export function nonPacedPacing(paced: VideoPacing): VideoPacing {
  return { ...paced, slowMoMs: 0, assertDwellMs: 0, cursorTravelMs: 0 };
}

/**
 * Renders an MP4 from a recorded WebM, persisting the timeline and degrading to
 * the raw WebM under a stable name when ffmpeg is missing or fails. Returns the
 * artifact path, or undefined when no WebM was produced at all.
 */
function renderDemo(
  recorded: RecordedReplay,
  scenario: Scenario,
  runDir: string,
  pacing: VideoPacing,
  size: { width: number; height: number }
): string | undefined {
  const webm = recorded.webm;
  if (!webm || !fs.existsSync(webm)) {
    console.warn("[scout] video: replay produced no WebM file.");
    return undefined;
  }
  fs.writeFileSync(
    path.join(runDir, "demo.timeline.json"),
    JSON.stringify(recorded.timeline, null, 2) + "\n"
  );
  const result = generateVideo({
    webmPath: webm,
    outPath: path.join(runDir, "demo.mp4"),
    width: size.width,
    height: size.height,
    scenarioName: scenario.name,
    verdict: "verified",
    timeline: recorded.timeline,
    pacing,
  });
  if (result.warning) console.warn(`[scout] video: ${result.warning}`);
  if (result.output && result.output !== webm) {
    fs.rmSync(webm, { force: true }); // MP4 superseded the intermediate WebM
    return result.output;
  }
  // Fallback (no/failed ffmpeg): keep the raw WebM under a stable name.
  const dest = path.join(runDir, "demo.webm");
  try {
    fs.renameSync(webm, dest);
    return dest;
  } catch {
    return webm;
  }
}

/**
 * Orchestrates demo-video generation, decoupled from the browser so it can be
 * tested: `attempt` performs one recorded replay at a given pacing and returns
 * its outcome + WebM. Best-effort and post-verdict — never touches the verdict.
 *
 * The verified scenario must NEVER yield zero video. The first attempt is paced
 * (slowMo + dwell + cursor) for human viewing. If that paced replay fails — the
 * pacing sometimes perturbs timing on flows the authoritative run handled fine
 * (e.g. a cookie banner) — we fall back to a non-paced replay that mirrors the
 * authoritative run, which passed, so a usable clip is still produced. Only if
 * the fallback ALSO fails do we warn and yield no video.
 */
export async function recordDemoVideoFrom(
  attempt: (pacing: VideoPacing) => Promise<RecordedReplay>,
  scenario: Scenario,
  runDir: string,
  pacing: VideoPacing,
  size: { width: number; height: number } = { width: 390, height: 844 }
): Promise<string | undefined> {
  const paced = await attempt(pacing);
  if (paced.passed) return renderDemo(paced, scenario, runDir, pacing, size);
  if (paced.webm) fs.rmSync(paced.webm, { force: true }); // discard the failed paced take

  console.warn(
    "[scout] video: paced demo replay failed; recorded a non-paced fallback clip (verdict unaffected)." +
      (paced.failure ? ` Paced replay tripped on ${paced.failure}.` : "")
  );
  const fallbackPacing = nonPacedPacing(pacing);
  const fallback = await attempt(fallbackPacing);
  if (fallback.passed) return renderDemo(fallback, scenario, runDir, fallbackPacing, size);

  if (fallback.webm) fs.rmSync(fallback.webm, { force: true });
  console.warn(
    "[scout] video: non-paced fallback replay also failed — no video generated (verdict unaffected)." +
      (fallback.failure ? ` Replay tripped on ${fallback.failure}.` : "") +
      " This usually means the scenario doesn't replay deterministically (it heals via AI each run), so there is no clean replay to film."
  );
  return undefined;
}

/**
 * Runs one extra, paced replay of the verified script with video recording on
 * (and the synthetic demo cursor injected), then renders it to a GitHub-ready
 * MP4 with baked step labels + verdict card. On a paced-replay failure it
 * retries without pacing so a verified scenario still yields a clip; the verdict
 * is never affected.
 */
async function recordDemoVideo(
  scenario: Scenario,
  steps: Step[],
  config: ScoutConfig,
  viewport: ResolvedViewport,
  storageState: string | undefined,
  cookies: ScenarioCookie[] | undefined,
  storage: ScenarioStorage | undefined,
  runDir: string
): Promise<string | undefined> {
  const attempt = async (pacing: VideoPacing): Promise<RecordedReplay> => {
    let session: BrowserSession;
    try {
      session = await BrowserSession.launch({
        baseUrl: config.baseUrl,
        headless: config.headless,
        storageState,
        locale: config.locale,
        runDir,
        viewport,
        recordVideo: true,
        demoCursor: true,
        slowMoMs: pacing.slowMoMs,
        permissions: scenario.permissions,
        cookies,
        storage,
        extraHeaders: config.headers,
        testIdAttribute: config.testIdAttribute,
      });
    } catch {
      console.warn("[scout] video: could not open the browser for the demo replay.");
      return { passed: false, timeline: [], failure: "could not open the browser" };
    }
    const demo = await replayForDemo(
      session,
      steps,
      pacing.assertDwellMs,
      pacing.cursorTravelMs,
      pacing.verdictCardMs
    );
    const { video: webm } = await session.close();
    return { passed: demo.passed, webm, timeline: demo.timeline, failure: demo.failure };
  };

  return recordDemoVideoFrom(attempt, scenario, runDir, pacingFor(config.videoSpeed), {
    width: viewport.width,
    height: viewport.height,
  });
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
  viewport: ResolvedViewport,
  storageState: string | undefined,
  cookies: ScenarioCookie[] | undefined,
  storage: ScenarioStorage | undefined,
  opts: RunOptions
): Promise<{ result: RunResult; steps: Step[] }> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const transcript: string[] = [];
  const screenshots: string[] = [];
  let trace: string | undefined;

  const { outcome, attempts } = await runAiWithRetry(async (attemptNo) => {
    if (attemptNo > 1) transcript.push(`[scout] Attempt ${attemptNo}: previous run failed in the runner — new browser, new agent.`);
    const session = await BrowserSession.launch({
      baseUrl: config.baseUrl,
      headless: opts.headed ? false : config.headless,
      storageState,
      locale: config.locale,
      runDir,
      viewport,
      permissions: scenario.permissions,
      cookies,
      storage,
      extraHeaders: config.headers,
      testIdAttribute: config.testIdAttribute,
    });
    let result;
    try {
      result = await runWithAgent(session, scenario, config, viewport);
    } finally {
      await session.screenshot("final-state").catch(() => {});
    }
    trace = (await session.close()).trace;
    transcript.push(...result.transcript);
    for (const shot of session.screenshots) if (!screenshots.includes(shot)) screenshots.push(shot);
    return result;
  });

  fs.writeFileSync(path.join(runDir, "transcript.md"), transcript.join("\n\n---\n\n"));

  // Ephemeral runs (the --viewport override) verify but never persist a script,
  // so a forced viewport the scenario doesn't declare leaves no orphan behind.
  if (outcome.verdict === "verified" && outcome.steps.length && !(opts.ephemeral ?? false)) {
    store.saveSteps(scenario.slug, viewport.name, pruneSteps(outcome.steps));
  }

  return {
    result: {
      slug: scenario.slug,
      viewport: viewport.name,
      mode: "ai",
      verdict: outcome.verdict,
      reason: outcome.runnerFailure
        ? `${outcome.reason} (${attempts} AI run attempts — investigate the artifacts in ${runDir})`
        : outcome.reason,
      stepCount: outcome.steps.length,
      runDir,
      startedAt,
      durationMs: Date.now() - start,
      screenshots,
      trace,
      runnerFailure: outcome.runnerFailure,
    },
    steps: outcome.steps,
  };
}

/** Steps that can sit between two fills of the same field without consuming its value. */
const INERT_BETWEEN_FILLS = new Set<Step["kind"]>([
  "waitForText",
  "waitForUrl",
  "assertVisible",
  "assertNotVisible",
  "assertState",
  "assertUrl",
  "assertNetwork",
  "assertNoConsoleErrors",
  "assertConsoleMessage",
  "screenshot",
]);

function targetKey(target: Target): string {
  return JSON.stringify([
    target.role ?? null,
    target.name ?? null,
    target.css ?? null,
    target.testId ?? null,
    target.text ?? null,
  ]);
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
