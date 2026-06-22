import fs from "node:fs";
import path from "node:path";
import { SCOUT_DIR } from "./config.js";
import { SPECS_DIR, loadScenarios, slugToToken } from "./specs.js";
import type { RunResult, Scenario, Step } from "./types.js";

/**
 * Filesystem store inside the target project:
 *   .scout/specs/<feature>.scout.md  — committed (the suite; markdown source of truth)
 *   .scout/scripts/<slug>.json       — committed (cached deterministic steps; `<slug>` is `<file>/<scenario>`)
 *   .scout/runs/<runId>/             — gitignored (artifacts per run)
 *   .scout/state/<profile>.json      — gitignored (auth storageState)
 */
export class Store {
  readonly root: string;
  readonly cwd: string;

  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.root = path.join(cwd, SCOUT_DIR);
  }

  init(): void {
    fs.mkdirSync(path.join(this.root, SPECS_DIR), { recursive: true });
    fs.mkdirSync(path.join(this.root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(this.root, "runs"), { recursive: true });
    fs.mkdirSync(path.join(this.root, "state"), { recursive: true });
    const gitignore = path.join(this.root, ".gitignore");
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(gitignore, "runs/\nstate/\n");
    }
    const example = path.join(this.root, SPECS_DIR, "example.scout.md");
    if (!fs.existsSync(example)) {
      fs.writeFileSync(example, EXAMPLE_SPEC);
    }
  }

  exists(): boolean {
    return fs.existsSync(this.root);
  }

  listScenarios(): Scenario[] {
    return loadScenarios(this.cwd);
  }

  getScenario(slug: string): Scenario | undefined {
    return this.listScenarios().find((s) => s.slug === slug);
  }

  // ---- cached deterministic scripts ----

  scriptPath(slug: string): string {
    return path.join(this.root, "scripts", `${slug}.json`);
  }

  loadSteps(slug: string): Step[] | undefined {
    const file = this.scriptPath(slug);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  saveSteps(slug: string, steps: Step[]): void {
    const file = this.scriptPath(slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(steps, null, 2) + "\n");
  }

  // ---- runs ----

  newRunDir(slug: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(this.root, "runs", `${stamp}-${slugToToken(slug)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  saveRunResult(result: RunResult): void {
    fs.writeFileSync(
      path.join(result.runDir, "result.json"),
      JSON.stringify(result, null, 2) + "\n"
    );
  }

  /** Latest run result per scenario slug (for `scout report`) */
  latestRuns(): Map<string, RunResult> {
    const runsDir = path.join(this.root, "runs");
    const map = new Map<string, RunResult>();
    if (!fs.existsSync(runsDir)) return map;
    const dirs = fs.readdirSync(runsDir).sort(); // timestamp prefix → chronological
    for (const dir of dirs) {
      const file = path.join(runsDir, dir, "result.json");
      if (!fs.existsSync(file)) continue;
      const result: RunResult = JSON.parse(fs.readFileSync(file, "utf8"));
      map.set(result.slug, result); // later overwrites earlier
    }
    return map;
  }
}

// The example sits inside a fenced block so it loads as ZERO scenarios — it
// documents the format without polluting the suite (or the `--check` gate).
const EXAMPLE_SPEC = `---
feature: Example
---

# How to write a scout spec

One file per feature/component. File-level frontmatter sets defaults
(\`feature\`, \`profile\`, \`tags\`). Each \`##\` heading is one scenario; optional
\`profile\`/\`notes\`/\`tags\` override lines may follow a heading before the prose.
Write the flow + expected behavior in plain language — no selectors, no code.

Copy the block below into a new \`*.scout.md\` file (outside the fence) to start:

\`\`\`markdown
---
feature: Paywall
profile: anon
tags: [monetization]
---

## Free user hits paywall on ep 3
Open ep 3 of series X without login; paywall appears with a signup CTA.

## Subscriber bypasses paywall
profile: qa

Logged-in subscriber opens ep 3; plays with no paywall.
\`\`\`
`;
