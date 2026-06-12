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
  id: number;
  slug: string;
  name: string;
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

/** Structured suite report (the `scout report --json` output) — for CI/PR gates. */
export function buildReport(scenarios: Scenario[]): ReportData {
  const count = (status: ScenarioStatus) => scenarios.filter((s) => s.status === status).length;
  return {
    scenarios: scenarios.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      profile: s.profile ?? null,
      status: s.status,
      lastRun: s.lastRun ?? null,
    })),
    summary: {
      total: scenarios.length,
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
    `| # | Scenario | Profile | Status | Mode | Last run |`,
    `|---|---------|---------|--------|------|------------|`,
  ];
  for (const s of scenarios) {
    const run = latest.get(s.slug);
    const mode = run ? (run.mode === "replay" ? "replay" : run.healed ? "AI (healed)" : "AI") : "—";
    lines.push(
      `| ${s.id} | ${s.name} | ${s.profile ?? "anonymous"} | ${ICON[s.status]} ${s.status} | ${mode} | ${s.lastRun ? s.lastRun.slice(0, 16).replace("T", " ") : "never"} |`
    );
  }

  const failing = scenarios.filter((s) => s.status === "failed" || s.status === "blocked");
  if (failing.length) {
    lines.push(``, `### Failures`, ``);
    for (const s of failing) {
      const run = latest.get(s.slug);
      lines.push(`- **${s.name}**: ${run?.reason ?? "no run recorded"}`);
    }
  }

  const verified = scenarios.filter((s) => s.status === "verified").length;
  lines.push(``, `**${verified}/${scenarios.length} verified.**`);
  return lines.join("\n") + "\n";
}
