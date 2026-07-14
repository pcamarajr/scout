import { resolveCookies, resolveStorage, type ScoutConfig } from "../config.js";
import { inferProvider } from "../credentials.js";
import type { ResolvedViewport } from "../viewports.js";
import type { Scenario, Step, Verdict } from "../types.js";
import { createScoutTools } from "./agent-tools.js";
import { selectEngine } from "./engines/index.js";
import {
  describeNoVerdict,
  relativizeUrl,
  type AiRunOutcome,
  type QueryEndInfo,
} from "./engines/types.js";
import { BrowserSession } from "./browser.js";

// Re-exported from their new home so existing importers (src/index.ts, callers)
// keep working unchanged.
export { describeNoVerdict, relativizeUrl };
export type { AiRunOutcome, QueryEndInfo };

/**
 * AI-driven run, engine-neutral orchestrator. A Claude agent (via the Agent SDK
 * by default, or the Vercel AI SDK when selected) navigates the real browser to
 * verify the scenario. Every successful action is recorded as a deterministic
 * Step so subsequent runs can replay without the LLM.
 *
 * Verdict capture, the forced-verdict rescue, and outcome assembly live HERE,
 * above both engines, so behavior is identical regardless of engine.
 */
export async function runWithAgent(
  session: BrowserSession,
  scenario: Scenario,
  config: ScoutConfig,
  viewport: ResolvedViewport
): Promise<AiRunOutcome> {
  const steps: Step[] = [];
  const transcript: string[] = [];
  let verdict: { verdict: Verdict; reason: string } | undefined;

  const tools = createScoutTools({
    session,
    config,
    record: (step) => steps.push(step),
    setVerdict: (v) => {
      verdict = v;
    },
  });

  const profileInfo = scenario.profile
    ? `Authenticated session with the profile "${scenario.profile}"${config.profiles[scenario.profile]?.description ? ` (${config.profiles[scenario.profile].description})` : ""}. You are ALREADY logged in — don't log in again unless the scenario asks for it.`
    : "Anonymous session (logged-out).";

  const envVars = scenario.profile ? (config.profiles[scenario.profile]?.env ?? []) : [];
  const envInfo = envVars.length
    ? `Env vars available via the $ENV:VAR placeholder (in browser_fill and in browser_navigate URLs): ${envVars.map((v) => `$ENV:${v}`).join(", ")}.`
    : "";

  // Cookies are seeded into the context by the runner before the flow. Announce
  // only the NAMES so the agent treats the precondition as satisfied — values
  // may be secrets ($ENV) and must never reach the LLM.
  const presetCookies = resolveCookies(scenario, config);
  const cookieInfo = presetCookies?.length
    ? `Cookies already set in the browser before the flow (precondition satisfied — do NOT try to set them, you have no tool for that): ${presetCookies.map((c) => c.name).join(", ")}.`
    : "";

  // Web storage is seeded into the context before the app loads, exactly like
  // cookies. Announce only the KEYS (values may be secrets) so the agent treats
  // the precondition as satisfied and never tries to set storage itself.
  const presetStorage = resolveStorage(scenario, config);
  const storageInfo = (() => {
    if (!presetStorage) return "";
    const seeded = [...Object.keys(presetStorage.local ?? {}), ...Object.keys(presetStorage.session ?? {})];
    const parts: string[] = [];
    if (seeded.length) parts.push(`seeded: ${seeded.join(", ")}`);
    if (presetStorage.remove?.length) parts.push(`cleared: ${presetStorage.remove.join(", ")}`);
    return parts.length
      ? `Browser storage (localStorage/sessionStorage) already applied before the flow loads (precondition satisfied — do NOT try to set or clear storage, you have no tool for that): ${parts.join("; ")}.`
      : "";
  })();

  const viewportInfo = `Viewport: running as "${viewport.name}" (${viewport.width}×${viewport.height}${viewport.isMobile ? ", mobile/touch" : ""}). Verify the layout for that size — on mobile expect a hamburger menu/compact nav; on desktop, a horizontal nav.`;

  const systemPrompt = `You are Scout, a QA agent that verifies scenarios in a real browser.

Target app: ${config.baseUrl}
${viewportInfo}
${profileInfo}
${envInfo}
${cookieInfo}
${storageInfo}

Working method:
1. Start with browser_navigate to the flow's starting page (or browser_snapshot if you're already there).
2. Execute the flow described in the scenario, step by step, always reading the snapshot before acting.
3. For EVERY scenario expectation, use browser_assert — the recorded assertions become the deterministic test that will run in CI without you.
4. When the scenario mentions console logs/errors or network/API calls: use browser_inspect_logs to see what happened, then browser_assert_network and/or browser_assert_no_console_errors to record the check.
5. Capture browser_screenshot as evidence at key moments.
6. ALWAYS finish with scout_verdict:
   - verified: all the expected behavior was confirmed by assertions
   - failed: expected behavior is broken (describe exactly what)
   - partial: part works, part doesn't, or not everything could be verified
   - blocked: couldn't even reach the flow (app down, broken login, etc.)

Rules:
- Act like a real user: one step at a time, wait for loads with browser_wait_for.
- If an element isn't in the snapshot, take a new snapshot or advance the flow another way — don't invent refs.
- Gesture-driven UIs (vertical feed, carousel, swipe between items) often don't respond to the keyboard: use browser_wheel (scroll at a position) or browser_drag (point-to-point drag) and check the result in the next snapshot.
- Never use literal secrets: use $ENV:VAR_NAME — it works both in browser_fill and in browser_navigate URLs (e.g. tokens in the query string).
- Don't re-fill a field you already filled, unless the page cleared the value — each of your actions becomes a step in the recorded script, and duplicate steps are noise that makes replay fragile.
- Network/console assertions must be TOLERANT: match requests by method + URL pattern + status; only use responseIncludes with stable substrings (field names), never ids/timestamps. An assertion glued to a volatile value breaks on replay.
- Be economical: don't explore beyond the scenario. Your budget is ${config.maxTurns} actions.
- If you're repeating attempts without progress (a blocking overlay, an element that won't appear), STOP and call scout_verdict (partial or blocked) explaining the obstacle — a partial verdict is worth more than dying without a verdict.`;

  const userPrompt = `Verify this QA scenario:\n\n## ${scenario.name}\n\n${scenario.scenario}${scenario.notes ? `\n\nNotes: ${scenario.notes}` : ""}`;

  const provider = inferProvider(config.model);
  const engine = selectEngine(provider, config.engine);
  const run = await engine.run({
    provider,
    model: config.model,
    systemPrompt,
    userPrompt,
    tools,
    maxTurns: config.maxTurns,
  });
  transcript.push(...run.transcript);
  let endInfo: QueryEndInfo | undefined = run.end;

  // Forced-verdict rescue: the agent died mute (typically error_max_turns).
  // Resume the same session with a tiny turn budget and demand scout_verdict
  // with whatever it observed — a partial verdict beats a silent death.
  const mainCause = verdict ? undefined : describeNoVerdict(endInfo, config.maxTurns);
  if (!verdict) {
    transcript.push(
      `[scout] Agent ended without a verdict (${mainCause}) — rescue: demanding scout_verdict with what was observed.`
    );
    try {
      const rescue = await run.resume(
        "Your verification hit the action limit. Do NOT run any more browser actions. Call scout_verdict NOW based on what you already observed: 'partial' if the verification was incomplete, 'blocked' if you didn't even reach the flow, 'failed'/'verified' only if you already had enough evidence.",
        4
      );
      transcript.push(...rescue.transcript);
      endInfo = rescue.end;
    } catch (error) {
      transcript.push(`[scout] Verdict rescue failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!verdict) {
    const cause = mainCause ?? describeNoVerdict(endInfo, config.maxTurns);
    return {
      verdict: "blocked",
      reason: `RUNNER failure, not a UI verdict: ${cause}; scout_verdict was not called, even in the verdict rescue.`,
      steps,
      transcript,
      runnerFailure: cause,
    };
  }

  return { ...verdict, steps, transcript };
}
