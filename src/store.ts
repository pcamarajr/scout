import fs from "node:fs";
import path from "node:path";
import { SCOUT_DIR } from "./config.js";
import type { RunResult, Scenario, Step } from "./types.js";

/**
 * Filesystem store inside the target project:
 *   .scout/scenarios.json        — committed (the suite definition)
 *   .scout/scripts/<slug>.json   — committed (cached deterministic steps)
 *   .scout/runs/<runId>/         — gitignored (artifacts per run)
 *   .scout/state/<profile>.json  — gitignored (auth storageState)
 */
export class Store {
  readonly root: string;

  constructor(cwd = process.cwd()) {
    this.root = path.join(cwd, SCOUT_DIR);
  }

  init(): void {
    fs.mkdirSync(path.join(this.root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(this.root, "runs"), { recursive: true });
    fs.mkdirSync(path.join(this.root, "state"), { recursive: true });
    const gitignore = path.join(this.root, ".gitignore");
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(gitignore, "runs/\nstate/\n");
    }
    if (!fs.existsSync(this.scenariosFile)) {
      fs.writeFileSync(this.scenariosFile, "[]\n");
    }
  }

  get scenariosFile(): string {
    return path.join(this.root, "scenarios.json");
  }

  exists(): boolean {
    return fs.existsSync(this.scenariosFile);
  }

  listScenarios(): Scenario[] {
    if (!this.exists()) return [];
    return JSON.parse(fs.readFileSync(this.scenariosFile, "utf8"));
  }

  saveScenarios(scenarios: Scenario[]): void {
    fs.writeFileSync(this.scenariosFile, JSON.stringify(scenarios, null, 2) + "\n");
  }

  addScenario(input: { name: string; scenario: string; profile?: string; notes?: string }): Scenario {
    const scenarios = this.listScenarios();
    const id = scenarios.length ? Math.max(...scenarios.map((s) => s.id)) + 1 : 1;
    const scenario: Scenario = {
      id,
      slug: slugify(input.name),
      name: input.name,
      scenario: input.scenario,
      profile: input.profile,
      notes: input.notes,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    scenarios.push(scenario);
    this.saveScenarios(scenarios);
    return scenario;
  }

  getScenario(idOrSlug: number | string): Scenario | undefined {
    return this.listScenarios().find((s) => s.id === Number(idOrSlug) || s.slug === idOrSlug);
  }

  updateScenario(id: number, patch: Partial<Scenario>): void {
    const scenarios = this.listScenarios();
    const idx = scenarios.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`Scenario ${id} not found`);
    scenarios[idx] = { ...scenarios[idx], ...patch };
    this.saveScenarios(scenarios);
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
    fs.writeFileSync(this.scriptPath(slug), JSON.stringify(steps, null, 2) + "\n");
  }

  // ---- runs ----

  newRunDir(slug: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(this.root, "runs", `${stamp}-${slug}`);
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

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
