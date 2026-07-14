import fs from "node:fs";
import path from "node:path";
import { mergeCookiesByName, validateCookie } from "./cookies.js";
import { isEmptyStorage, mergeStorage, validateStorage } from "./storage.js";
import type { Scenario, ScenarioCookie, ScenarioStorage, Viewport } from "./types.js";

/** Filesystem/report-safe viewport names (mirrors viewports.ts, kept inline so
 *  config has no Playwright dependency). */
const VIEWPORT_NAME_RE = /^[a-z0-9-]+$/;

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
  /**
   * Cookies seeded into the context for every scenario on this profile (the
   * shared base). A scenario's own cookies merge on top, by name. Each is a
   * cookie object ({ name, value, domain?, path?, expires?, httpOnly?, secure?,
   * sameSite? }); `value` may carry a $ENV:VAR placeholder.
   */
  cookies?: ScenarioCookie[];
  /**
   * Web storage seeded into the context for every scenario on this profile (the
   * shared base). A scenario's own storage merges on top (per key per namespace;
   * `remove` concatenated). Shape: `{ local?, session?, remove? }`; values may
   * carry a $ENV:VAR placeholder.
   */
  storage?: ScenarioStorage;
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
  /**
   * Named viewports a scenario may run in, keyed by name. Merged over the
   * built-ins (`mobile`/`desktop`/`tablet`) — a same-named entry overrides one.
   * Each is a Viewport descriptor (a `device` preset and/or explicit fields).
   */
  viewports?: Record<string, Viewport>;
  /** Viewport used when a scenario declares none. Defaults to `mobile`. */
  defaultViewport?: string;
  /** Locale forced on the browser context */
  locale?: string;
  /** Record a paced MP4 demo of the verified replay. Enable with --demo-video or SCOUT_RECORD_VIDEO=1. */
  recordVideo?: boolean;
  /** Demo pacing in (0,1]; <1 = slower so a human can follow. Default 0.35. */
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
  videoSpeed: 0.35,
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
  // Fail loud on a viewport name that can't serve as a script-file token —
  // catches the typo at config load, not when a run tries to write the path.
  for (const name of Object.keys(merged.viewports ?? {})) {
    if (!VIEWPORT_NAME_RE.test(name)) {
      throw new Error(
        `Invalid viewport name "${name}" in ${CONFIG_FILE}. Use lowercase letters, digits and hyphens.`
      );
    }
  }
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
      `Profile "${profileName}" does not exist in ${CONFIG_FILE}. Profiles: ${Object.keys(config.profiles).join(", ") || "(none)"}`
    );
  }
  const statePath = path.resolve(
    cwd,
    profile.storageState ?? path.join(SCOUT_DIR, "state", `${profileName}.json`)
  );
  if (!fs.existsSync(statePath)) {
    // Explicit configured path that is missing = user error.
    // Missing default path = fresh context — covers logged-out profiles
    // and profiles that log in within the scenario via $ENV.
    if (profile.storageState) {
      throw new Error(
        `storageState for profile "${profileName}" not found at ${statePath} (path configured in ${CONFIG_FILE}). Run: scout login ${profileName}`
      );
    }
    return undefined;
  }
  return statePath;
}

/**
 * Resolves the cookies for one scenario: the profile's cookies are the shared
 * base, the scenario's own cookies (file frontmatter + section override, already
 * merged in specs.ts) win on top — keyed by cookie name. Profile cookies come
 * from JSON, so they're validated here (lazily, like resolveStorageState) and a
 * bad one fails loud. Returns undefined when neither side declares any.
 */
export function resolveCookies(scenario: Scenario, config: ScoutConfig): ScenarioCookie[] | undefined {
  const profileName = scenario.profile;
  const profileRaw = profileName ? config.profiles[profileName]?.cookies : undefined;
  const profileCookies = Array.isArray(profileRaw)
    ? profileRaw.map((c, i) => validateCookie(c, `${CONFIG_FILE} profile "${profileName}" cookie #${i + 1}`))
    : [];
  const merged = mergeCookiesByName(profileCookies, scenario.cookies ?? []);
  return merged.length ? merged : undefined;
}

/**
 * Resolves the web storage for one scenario: the profile's storage is the shared
 * base, the scenario's own storage (file frontmatter + section override, already
 * merged in specs.ts) wins on top — per key per namespace, `remove` concatenated.
 * Profile storage comes from JSON, so it's validated here (lazily, like
 * resolveCookies) and a bad one fails loud. Returns undefined when neither side
 * seeds or removes anything.
 */
export function resolveStorage(scenario: Scenario, config: ScoutConfig): ScenarioStorage | undefined {
  const profileName = scenario.profile;
  const profileRaw = profileName ? config.profiles[profileName]?.storage : undefined;
  const profileStorage = profileRaw
    ? validateStorage(profileRaw, `${CONFIG_FILE} profile "${profileName}" storage`)
    : {};
  const merged = mergeStorage(profileStorage, scenario.storage ?? {});
  return isEmptyStorage(merged) ? undefined : merged;
}
