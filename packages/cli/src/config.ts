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
  /** Record a paced MP4 preview of the verified replay. Enable with --record-video or SCOUT_RECORD_VIDEO=1. */
  recordVideo?: boolean;
  /** Preview pacing in (0,1]; <1 = slower so a human can follow. Default 0.4. */
  videoSpeed?: number;
  /**
   * Agent engine for AI runs. `agent-sdk` (default) uses the trusted
   * @anthropic-ai/claude-agent-sdk; `ai-sdk` uses the Vercel AI SDK. Override
   * with SCOUT_ENGINE. Unset = provider-aware default (agent-sdk for Anthropic,
   * ai-sdk for other providers).
   */
  engine?: "agent-sdk" | "ai-sdk";
  /**
   * Extra HTTP headers sent on every browser request (AI runs and replay
   * alike). Use to reach a protected target — e.g. a Vercel preview behind
   * Deployment Protection needs `x-vercel-protection-bypass`. Override per
   * CI/worktree with SCOUT_EXTRA_HEADERS (a JSON object string).
   */
  headers?: Record<string, string>;
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
  recordVideo: false,
  videoSpeed: 0.4,
  profiles: {},
};

/** Per-invocation overrides (CLI flags, MCP tool params). Highest precedence. */
export interface ConfigOverrides {
  baseUrl?: string;
  recordVideo?: boolean;
}

/**
 * Parse SCOUT_EXTRA_HEADERS — a JSON object of header→value, all strings.
 * Throws on malformed input or non-string values so a typo fails loud rather
 * than silently dropping the bypass header (and leaving the run hitting a login
 * wall). An empty object is valid and yields no headers.
 */
export function parseHeadersEnv(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`SCOUT_EXTRA_HEADERS must be a JSON object, e.g. '{"x-vercel-protection-bypass":"…"}'. Got: ${raw}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`SCOUT_EXTRA_HEADERS must be a JSON object of string values, not ${Array.isArray(parsed) ? "an array" : typeof parsed}.`);
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`SCOUT_EXTRA_HEADERS["${key}"] must be a string, got ${typeof value}.`);
    }
    headers[key] = value;
  }
  return headers;
}

/** Precedence: overrides (flag) > env (SCOUT_*) > scout.config.json > defaults. */
export function loadConfig(cwd = process.cwd(), overrides: ConfigOverrides = {}): ScoutConfig {
  const file = path.join(cwd, CONFIG_FILE);
  let fromFile: Partial<ScoutConfig> = {};
  if (fs.existsSync(file)) {
    fromFile = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const merged: ScoutConfig = { ...DEFAULTS, ...fromFile };
  if (process.env.SCOUT_BASE_URL) merged.baseUrl = process.env.SCOUT_BASE_URL;
  if (process.env.SCOUT_MODEL) merged.model = process.env.SCOUT_MODEL;
  if (process.env.SCOUT_HEADED === "1") merged.headless = false;
  if (process.env.SCOUT_RECORD_VIDEO === "1") merged.recordVideo = true;
  if (process.env.SCOUT_ENGINE === "agent-sdk" || process.env.SCOUT_ENGINE === "ai-sdk") {
    merged.engine = process.env.SCOUT_ENGINE;
  }
  if (process.env.SCOUT_EXTRA_HEADERS) {
    merged.headers = { ...merged.headers, ...parseHeadersEnv(process.env.SCOUT_EXTRA_HEADERS) };
  }
  if (overrides.baseUrl) merged.baseUrl = overrides.baseUrl;
  if (overrides.recordVideo) merged.recordVideo = true;
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
    // Caminho explícito configurado e ausente = erro do usuário.
    // Caminho default ausente = contexto fresh — cobre profiles logged-out
    // e profiles que logam dentro do cenário via $ENV.
    if (profile.storageState) {
      throw new Error(
        `storageState do profile "${profileName}" não encontrado em ${statePath} (caminho configurado em ${CONFIG_FILE}). Rode: scout login ${profileName}`
      );
    }
    return undefined;
  }
  return statePath;
}
