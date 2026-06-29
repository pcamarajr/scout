import path from "node:path";
import { describeStep } from "./runner/script-runner.js";
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
    steps.forEach((s, i) => lines.push(`${i + 1}. ${describeStep(s)}`));
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

/** Status of a scenario derived from its latest run (pure-input specs never store it). */
export function scenarioStatus(slug: string, latest: Map<string, RunResult>): ScenarioStatus {
  return latest.get(slug)?.verdict ?? "pending";
}

/** Structured suite report (the `scout report --json` output) — for CI/PR gates. */
export function buildReport(scenarios: Scenario[], latest: Map<string, RunResult>): ReportData {
  const rows: ReportScenario[] = scenarios.map((s) => ({
    slug: s.slug,
    name: s.name,
    feature: s.feature,
    profile: s.profile ?? null,
    status: scenarioStatus(s.slug, latest),
    lastRun: latest.get(s.slug)?.startedAt ?? null,
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
export function renderSummary(scenarios: Scenario[], latest: Map<string, RunResult>): string {
  const lines = [
    `## 🔭 Scout — browser verification`,
    ``,
    `| Feature | Scenario | Profile | Status | Mode | Last run |`,
    `|---------|----------|---------|--------|------|----------|`,
  ];
  for (const s of scenarios) {
    const run = latest.get(s.slug);
    const status = scenarioStatus(s.slug, latest);
    const mode = run ? (run.mode === "replay" ? "replay" : run.healed ? "AI (healed)" : "AI") : "—";
    lines.push(
      `| ${s.feature} | ${s.name} | ${s.profile ?? "anonymous"} | ${ICON[status]} ${status} | ${mode} | ${run?.startedAt ? run.startedAt.slice(0, 16).replace("T", " ") : "never"} |`
    );
  }

  const failing = scenarios.filter((s) => {
    const status = scenarioStatus(s.slug, latest);
    return status === "failed" || status === "blocked";
  });
  if (failing.length) {
    lines.push(``, `### Failures`, ``);
    for (const s of failing) {
      const run = latest.get(s.slug);
      lines.push(`- **${s.name}**: ${run?.reason ?? "no run recorded"}`);
    }
  }

  const verified = scenarios.filter((s) => scenarioStatus(s.slug, latest) === "verified").length;
  lines.push(``, `**${verified}/${scenarios.length} verified.**`);
  return lines.join("\n") + "\n";
}
