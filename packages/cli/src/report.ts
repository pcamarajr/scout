import path from "node:path";
import { describeStep } from "./runner/script-runner.js";
import { fragileWarning } from "./runner/selector-ladder.js";
import { expandScenarios, runKey, type ViewportSelectionConfig } from "./viewports.js";
import type { RunResult, Scenario, ScenarioStatus, Step } from "./types.js";

const ICON: Record<ScenarioStatus, string> = {
  verified: "✅",
  failed: "❌",
  partial: "⚠️",
  blocked: "🚫",
  pending: "⏳",
};

/** Per-run report saved at .scout/runs/<id>/report.md */
export function renderRunReport(result: RunResult, scenario: Scenario, steps?: Step[]): string {
  const lines = [
    `# ${ICON[result.verdict]} ${scenario.name}`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Verdict | **${result.verdict}**${result.runnerFailure ? " ⚠️ runner failure — not a UI judgment" : ""} |`,
    `| Mode | ${result.mode === "replay" ? "deterministic replay" : "AI-driven"}${result.healed ? " (healed)" : ""} |`,
    `| Viewport | ${result.viewport} |`,
    `| Profile | ${scenario.profile ?? "anonymous"} |`,
    `| Duration | ${(result.durationMs / 1000).toFixed(1)}s |`,
    `| Started | ${result.startedAt} |`,
    ``,
    `**Scenario:** ${scenario.scenario}`,
    ``,
    `**Resultado:** ${result.reason}`,
  ];

  if (steps?.length) {
    lines.push(``, `## Recorded script (${steps.length} steps)`, ``);
    steps.forEach((s, i) => {
      const fragile = "target" in s && s.target.fragile ? " ⚠️ fragile (positional selector)" : "";
      lines.push(`${i + 1}. ${describeStep(s)}${fragile}`);
    });
  }

  if (result.fragileSteps?.length) {
    lines.push(
      ``,
      `## ⚠️ Fragile selectors`,
      ``,
      `These steps recorded a positional selector — they replay now but break when the DOM shifts. Add a stable handle to make replay robust:`,
      ``
    );
    for (const step of result.fragileSteps) lines.push(`- ${fragileWarning(step)}`);
  }

  if (result.usedFallbacks?.length) {
    lines.push(
      ``,
      `## Fallback selectors used`,
      ``,
      `A primary selector no longer resolved; a recorded fallback rescued the step deterministically (no AI). Consider re-recording to refresh the primary:`,
      ``
    );
    for (const note of result.usedFallbacks) lines.push(`- ${note}`);
  }

  if (result.screenshots.length) {
    lines.push(``, `## Evidence`, ``);
    for (const shot of result.screenshots) {
      const name = path.basename(shot);
      lines.push(`![${name}](./${name})`);
    }
  }

  if (result.video) {
    const name = path.basename(result.video);
    lines.push(
      ``,
      `## Demo`,
      ``,
      `<video src="./${name}" controls></video>`,
      ``,
      `[▶ ${name}](./${name}) — demo of the verified flow.`
    );
  }

  if (result.trace) {
    lines.push(
      ``,
      `## Trace`,
      ``,
      `\`npx playwright show-trace ${result.trace}\` — screenshots, DOM snapshots, network and console for the entire session.`
    );
  }

  return lines.join("\n") + "\n";
}

export interface ReportScenario {
  slug: string;
  name: string;
  feature: string;
  profile: string | null;
  /** Viewport this row was verified in — each (scenario × viewport) is a row. */
  viewport: string;
  status: ScenarioStatus;
  lastRun: string | null;
}

export interface ReportData {
  scenarios: ReportScenario[];
  summary: {
    total: number;
    verified: number;
    failed: number;
    partial: number;
    blocked: number;
    pending: number;
  };
}

/**
 * Status of one (scenario × viewport) unit, derived from its latest run
 * (pure-input specs never store it). Keyed `<slug>@<viewport>`.
 */
export function runStatus(slug: string, viewport: string, latest: Map<string, RunResult>): ScenarioStatus {
  return latest.get(runKey(slug, viewport))?.verdict ?? "pending";
}

/**
 * Status of a scenario regardless of viewport: the verdict of its most recent
 * run, else `"pending"` — the pre-0.11 per-slug semantics. Scans map values,
 * so it accepts both 0.10 maps (keyed by slug) and current ones (keyed
 * `<slug>@<viewport>`).
 *
 * @deprecated Since 0.11 each (scenario × viewport) is verified independently —
 * use {@link runStatus} for a per-viewport status. Kept as a stable alias for
 * pre-0.11 consumers.
 */
export function scenarioStatus(slug: string, latest: Map<string, RunResult>): ScenarioStatus {
  let newest: RunResult | undefined;
  for (const run of latest.values()) {
    if (run.slug !== slug) continue;
    if (!newest || run.startedAt > newest.startedAt) newest = run;
  }
  return newest?.verdict ?? "pending";
}

/** Structured suite report (the `scout report --json` output) — for CI/PR gates. */
export function buildReport(
  scenarios: Scenario[],
  latest: Map<string, RunResult>,
  config: ViewportSelectionConfig = {}
): ReportData {
  const rows: ReportScenario[] = expandScenarios(scenarios, config).map(({ scenario, viewport }) => ({
    slug: scenario.slug,
    name: scenario.name,
    feature: scenario.feature,
    profile: scenario.profile ?? null,
    viewport,
    status: runStatus(scenario.slug, viewport, latest),
    lastRun: latest.get(runKey(scenario.slug, viewport))?.startedAt ?? null,
  }));
  const count = (status: ScenarioStatus) => rows.filter((r) => r.status === status).length;
  return {
    scenarios: rows,
    summary: {
      total: rows.length,
      verified: count("verified"),
      failed: count("failed"),
      partial: count("partial"),
      blocked: count("blocked"),
      pending: count("pending"),
    },
  };
}

/** Suite summary — PR-embeddable (the \`scout report\` output). */
export function renderSummary(
  scenarios: Scenario[],
  latest: Map<string, RunResult>,
  config: ViewportSelectionConfig = {}
): string {
  const units = expandScenarios(scenarios, config);
  const lines = [
    `## 🔭 Scout — browser verification`,
    ``,
    `| Feature | Scenario | Viewport | Profile | Status | Mode | Last run |`,
    `|---------|----------|----------|---------|--------|------|----------|`,
  ];
  for (const { scenario: s, viewport } of units) {
    const run = latest.get(runKey(s.slug, viewport));
    const status = runStatus(s.slug, viewport, latest);
    const mode = run ? (run.mode === "replay" ? "replay" : run.healed ? "AI (healed)" : "AI") : "—";
    lines.push(
      `| ${s.feature} | ${s.name} | ${viewport} | ${s.profile ?? "anonymous"} | ${ICON[status]} ${status} | ${mode} | ${run?.startedAt ? run.startedAt.slice(0, 16).replace("T", " ") : "never"} |`
    );
  }

  const failing = units.filter(({ scenario: s, viewport }) => {
    const status = runStatus(s.slug, viewport, latest);
    return status === "failed" || status === "blocked";
  });
  if (failing.length) {
    lines.push(``, `### Failures`, ``);
    for (const { scenario: s, viewport } of failing) {
      const run = latest.get(runKey(s.slug, viewport));
      lines.push(`- **${s.name}** @${viewport}: ${run?.reason ?? "no run recorded"}`);
    }
  }

  const verified = units.filter(({ scenario: s, viewport }) => runStatus(s.slug, viewport, latest) === "verified").length;
  lines.push(``, `**${verified}/${units.length} verified.**`);
  return lines.join("\n") + "\n";
}
