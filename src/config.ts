import fs from "node:fs";
import path from "node:path";

export interface ScoutProfile {
  /** Shown to the AI agent so it knows what kind of session this is */
  description?: string;
  /**
   * Playwright storageState JSON path. Defaults to .scout/state/<name>.json
   * (created by `scout login <name>`). Gitignored — each env captures its own.
   */
  storageState?: string;
  /**
   * Env var names the agent may reference as $ENV:NAME when filling forms
   * (e.g. credentials for login flows). Values never reach the LLM.
   */
  env?: string[];
}

export interface ScoutConfig {
  /** Target app. Override per worktree/CI with SCOUT_BASE_URL. */
  baseUrl: string;
  /** Model for AI runs. Override with SCOUT_MODEL. */
  model: string;
  /** Headless by default; SCOUT_HEADED=1 or --headed for local debugging. */
  headless: boolean;
  /** Max agent turns per AI run */
  maxTurns: number;
  /** Locale forced on the browser context */
  locale?: string;
  profiles: Record<string, ScoutProfile>;
}

export const CONFIG_FILE = "scout.config.json";
export const SCOUT_DIR = ".scout";

const DEFAULTS: ScoutConfig = {
  baseUrl: "http://localhost:3000",
  model: "claude-sonnet-4-6",
  headless: true,
  maxTurns: 40,
  locale: "pt-BR",
  profiles: {},
};

export function loadConfig(cwd = process.cwd()): ScoutConfig {
  const file = path.join(cwd, CONFIG_FILE);
  let fromFile: Partial<ScoutConfig> = {};
  if (fs.existsSync(file)) {
    fromFile = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const merged: ScoutConfig = { ...DEFAULTS, ...fromFile };
  if (process.env.SCOUT_BASE_URL) merged.baseUrl = process.env.SCOUT_BASE_URL;
  if (process.env.SCOUT_MODEL) merged.model = process.env.SCOUT_MODEL;
  if (process.env.SCOUT_HEADED === "1") merged.headless = false;
  return merged;
}

export function resolveStorageState(
  profileName: string | undefined,
  config: ScoutConfig,
  cwd = process.cwd()
): string | undefined {
  if (!profileName) return undefined;
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new Error(
      `Profile "${profileName}" não existe no ${CONFIG_FILE}. Profiles: ${Object.keys(config.profiles).join(", ") || "(nenhum)"}`
    );
  }
  const statePath = path.resolve(
    cwd,
    profile.storageState ?? path.join(SCOUT_DIR, "state", `${profileName}.json`)
  );
  if (!fs.existsSync(statePath)) {
    throw new Error(
      `storageState do profile "${profileName}" não encontrado em ${statePath}. Rode: scout login ${profileName}`
    );
  }
  return statePath;
}
