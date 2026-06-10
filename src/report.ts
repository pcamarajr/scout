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
    `| Veredito | **${result.verdict}** |`,
    `| Modo | ${result.mode === "replay" ? "replay determinístico" : "AI-driven"}${result.healed ? " (healed)" : ""} |`,
    `| Profile | ${scenario.profile ?? "anônimo"} |`,
    `| Duração | ${(result.durationMs / 1000).toFixed(1)}s |`,
    `| Início | ${result.startedAt} |`,
    ``,
    `**Cenário:** ${scenario.scenario}`,
    ``,
    `**Resultado:** ${result.reason}`,
  ];

  if (steps?.length) {
    lines.push(``, `## Script gravado (${steps.length} steps)`, ``);
    steps.forEach((s, i) => lines.push(`${i + 1}. ${describeStep(s)}`));
  }

  if (result.screenshots.length) {
    lines.push(``, `## Evidências`, ``);
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
      `\`npx playwright show-trace ${result.trace}\` — screenshots, DOM snapshots, network e console de toda a sessão.`
    );
  }

  return lines.join("\n") + "\n";
}

/** Suite summary — PR-embeddable (the \`scout report\` output). */
export function renderSummary(scenarios: Scenario[], latest: Map<string, RunResult>): string {
  const lines = [
    `## 🔭 Scout — verificação em browser`,
    ``,
    `| # | Cenário | Profile | Status | Modo | Último run |`,
    `|---|---------|---------|--------|------|------------|`,
  ];
  for (const s of scenarios) {
    const run = latest.get(s.slug);
    const mode = run ? (run.mode === "replay" ? "replay" : run.healed ? "AI (healed)" : "AI") : "—";
    lines.push(
      `| ${s.id} | ${s.name} | ${s.profile ?? "anônimo"} | ${ICON[s.status]} ${s.status} | ${mode} | ${s.lastRun ? s.lastRun.slice(0, 16).replace("T", " ") : "nunca"} |`
    );
  }

  const failing = scenarios.filter((s) => s.status === "failed" || s.status === "blocked");
  if (failing.length) {
    lines.push(``, `### Falhas`, ``);
    for (const s of failing) {
      const run = latest.get(s.slug);
      lines.push(`- **${s.name}**: ${run?.reason ?? "sem run registrado"}`);
    }
  }

  const verified = scenarios.filter((s) => s.status === "verified").length;
  lines.push(``, `**${verified}/${scenarios.length} verified.**`);
  return lines.join("\n") + "\n";
}
