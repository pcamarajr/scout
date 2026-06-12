/** How a recorded step finds its element on replay. */
export interface Target {
  /** ARIA role + accessible name — preferred, resilient to DOM refactors */
  role?: string;
  name?: string;
  /** CSS path fallback when role+name is not unique */
  css?: string;
  /** Human-readable label for reports */
  description: string;
}

export type Step =
  | { kind: "navigate"; url: string }
  | { kind: "click"; target: Target }
  | { kind: "fill"; target: Target; value: string }
  | { kind: "select"; target: Target; value: string }
  | { kind: "press"; key: string }
  | { kind: "waitForText"; text: string }
  | { kind: "waitForUrl"; pattern: string }
  | { kind: "assertVisible"; text: string }
  | { kind: "assertNotVisible"; text: string }
  | { kind: "assertUrl"; pattern: string }
  | { kind: "screenshot"; label: string };

export type Verdict = "verified" | "failed" | "partial" | "blocked";
export type ScenarioStatus = Verdict | "pending";

export interface Scenario {
  id: number;
  slug: string;
  name: string;
  /** Natural-language description of the flow + expected behavior */
  scenario: string;
  /** Auth profile name from scout.config.json (omit = anonymous) */
  profile?: string;
  status: ScenarioStatus;
  createdAt: string;
  lastRun?: string;
  notes?: string;
}

export interface RunResult {
  scenarioId: number;
  slug: string;
  /** replay = cached deterministic steps; ai = agent-driven run */
  mode: "replay" | "ai";
  verdict: Verdict;
  reason: string;
  stepCount?: number;
  failedStep?: string;
  runDir: string;
  startedAt: string;
  durationMs: number;
  screenshots: string[];
  trace?: string;
  /** true when this AI run replaced a broken cached script */
  healed?: boolean;
  /**
   * Set when the AI runner itself failed to obtain a verdict (infrastructure
   * failure: turn budget, SDK error). The verdict is "blocked" by convention,
   * but it is NOT a UI judgment — rerun instead of debugging the app.
   */
  runnerFailure?: string;
}
