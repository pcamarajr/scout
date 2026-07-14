import fs from "node:fs";
import path from "node:path";
import { SCOUT_DIR } from "./config.js";
import { SPECS_DIR, loadScenarios, slugToToken } from "./specs.js";
import type { RunResult, Scenario, Step } from "./types.js";

/**
 * Filesystem store inside the target project:
 *   .scout/specs/<feature>.scout.md       — committed (the suite; markdown source of truth)
 *   .scout/scripts/<slug>@<viewport>.json — committed (cached deterministic steps per viewport; `<slug>` is `<file>/<scenario>`)
 *   .scout/runs/<runId>/                  — gitignored (artifacts per run)
 *   .scout/state/<profile>.json           — gitignored (auth storageState)
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

  /** Committed script for one (scenario × viewport): `scripts/<slug>@<viewport>.json`. */
  scriptPath(slug: string, viewport: string): string {
    return path.join(this.root, "scripts", `${slug}@${viewport}.json`);
  }

  loadSteps(slug: string, viewport: string): Step[] | undefined {
    const file = this.scriptPath(slug, viewport);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  saveSteps(slug: string, viewport: string, steps: Step[]): void {
    const file = this.scriptPath(slug, viewport);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(steps, null, 2) + "\n");
  }

  // ---- runs ----

  newRunDir(slug: string, viewport: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(this.root, "runs", `${stamp}-${slugToToken(slug)}@${viewport}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  saveRunResult(result: RunResult): void {
    fs.writeFileSync(
      path.join(result.runDir, "result.json"),
      JSON.stringify(result, null, 2) + "\n"
    );
  }

  /**
   * Latest run result per (scenario × viewport), keyed `<slug>@<viewport>` (for
   * `scout report`). Each viewport is an independent verification unit, so two
   * viewports of the same scenario never overwrite each other.
   */
  latestRuns(): Map<string, RunResult> {
    const runsDir = path.join(this.root, "runs");
    const map = new Map<string, RunResult>();
    if (!fs.existsSync(runsDir)) return map;
    const dirs = fs.readdirSync(runsDir).sort(); // timestamp prefix → chronological
    for (const dir of dirs) {
      const file = path.join(runsDir, dir, "result.json");
      if (!fs.existsSync(file)) continue;
      const result: RunResult = JSON.parse(fs.readFileSync(file, "utf8"));
      map.set(`${result.slug}@${result.viewport}`, result); // later overwrites earlier
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
(\`feature\`, \`profile\`, \`tags\`, \`viewports\`, \`cookies\`, \`storage\`). Each \`##\`
heading is one scenario; optional \`profile\`/\`notes\`/\`tags\`/\`viewports\`/
\`cookies\`/\`storage\` override lines may follow a heading before the prose. A
scenario's \`viewports\` list (built-ins: mobile/desktop/tablet) REPLACES the
file-level one and fans the scenario out into one run per viewport.
\`cookies:\`/\`storage:\` seed browser preconditions before the app loads (never
recorded steps); a \`value\` may use a \`$ENV:VAR\` placeholder resolved at launch.
Write the flow + expected behavior in plain language — no selectors, no code.

Copy the block below into a new \`*.scout.md\` file (outside the fence) to start:

\`\`\`markdown
---
feature: Paywall
profile: anon
tags: [monetization]
viewports: [mobile]
cookies:                      # list of objects (attributes go here)
  - name: hn_checkout_variant
    value: A
storage:                      # object with local / session / remove
  local:
    hn_app_open_count: "2"
  remove:
    - hn_pwa_prompt_dismissed
---

## Free user hits paywall on ep 3
Open ep 3 of series X without login; paywall appears with a signup CTA.

## Subscriber bypasses paywall
profile: qa
viewports: [mobile, desktop]
cookies: hn_checkout_variant=C                    # inline override: name=value[, n2=v2]
storage: local.hn_app_open_count=3, remove=flag   # inline: local./session. keys, remove=key

Logged-in subscriber opens ep 3; plays with no paywall.
\`\`\`
`;
