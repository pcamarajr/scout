import type { AiProvider } from "../../credentials.js";
import type { Step, Verdict } from "../../types.js";
import type { ScoutTool } from "../agent-tools.js";

export interface AiRunOutcome {
  verdict: Verdict;
  reason: string;
  steps: Step[];
  transcript: string[];
  /**
   * Set when the runner itself failed to produce a verdict (agent never called
   * scout_verdict) — NOT a UI judgment. Callers may retry and must report it
   * as an infrastructure failure, never as "the scenario is blocked by the UI".
   */
  runnerFailure?: string;
}

/**
 * How an engine run ended, for no-verdict diagnostics. The Agent SDK fills this
 * from the SDK `result` message; the AI SDK engine maps its `finishReason` into
 * the same `subtype` vocabulary so {@link describeNoVerdict} works unchanged.
 */
export interface QueryEndInfo {
  subtype: string;
  numTurns?: number;
  errors?: string[];
}

/**
 * Human-readable cause for a run that ended without scout_verdict.
 * Distinguishes runner-infrastructure causes (turn budget, SDK errors) from
 * an agent that simply stopped talking.
 */
export function describeNoVerdict(end: QueryEndInfo | undefined, maxTurns: number): string {
  if (!end) return "the agent session ended without emitting a result (subprocess died?)";
  switch (end.subtype) {
    case "error_max_turns":
      return `the agent hit the ${maxTurns}-turn limit without calling scout_verdict`;
    case "error_during_execution":
      return `error during the agent's execution${end.errors?.length ? `: ${end.errors.join("; ")}` : ""}`;
    case "success":
      return "the agent ended normally without calling scout_verdict";
    default:
      return `the agent session ended with "${end.subtype}"${end.errors?.length ? `: ${end.errors.join("; ")}` : ""}`;
  }
}

/**
 * Records navigation relative to the configured baseUrl so cached scripts
 * survive --base-url / SCOUT_BASE_URL pointing at another server. URLs that
 * merely share the prefix (http://localhost:3000x) or live on other hosts
 * stay absolute.
 */
export function relativizeUrl(url: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (url === base || url === `${base}/`) return "/";
  if (url.startsWith(base)) {
    const rest = url.slice(base.length);
    if (rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#")) return rest;
  }
  return url;
}

/** Everything an engine needs to drive one agent run. */
export interface EngineRunSpec {
  /** Inferred from the model id; selects the AI SDK provider in the AI SDK engine. */
  provider: AiProvider;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: ScoutTool[];
  maxTurns: number;
}

/** The result of resuming a session (the forced-verdict rescue). */
export interface EngineResumeResult {
  end: QueryEndInfo;
  transcript: string[];
}

/**
 * A live (or just-finished) engine session. The shared orchestrator reads
 * `end`/`transcript`, and — if no verdict was captured — calls `resume()` to
 * run the forced-verdict rescue with a small turn budget.
 */
export interface EngineSession {
  end: QueryEndInfo;
  /** Assistant text collected during the run, in order. */
  transcript: string[];
  resume(prompt: string, maxTurns: number): Promise<EngineResumeResult>;
}

/** A pluggable agent engine. `run` performs the initial verification pass. */
export interface AgentEngine {
  run(spec: EngineRunSpec): Promise<EngineSession>;
}
