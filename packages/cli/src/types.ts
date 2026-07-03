/** How a recorded step finds its element on replay. */
export interface Target {
  /** ARIA role + accessible name — preferred, resilient to DOM refactors */
  role?: string;
  name?: string;
  /** CSS path fallback when role+name is not unique */
  css?: string;
  /** Human-readable label for reports */
  description: string;
}

/** HTTP status family used by network assertions when an exact code is too strict. */
export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";

/**
 * Tolerant matcher for a network request observed during the run. Matching is
 * by shape (method + URL glob + status), never by exact volatile values, so the
 * assertion survives deterministic replay despite dynamic ids/timestamps.
 */
export interface NetworkMatcher {
  /** HTTP method to match; omit to match any method. */
  method?: string;
  /** Glob over the request URL — `*` within a path segment, `**` across segments. */
  urlGlob: string;
  /** Exact status (e.g. 200) or a class (`2xx`); omit to match any. */
  status?: number | StatusClass;
  /**
   * Substrings that must ALL appear in the response body. Keep these stable
   * (field names like `orderId`), not volatile values (ids, timestamps).
   */
  responseIncludes?: string[];
}

/** Geographic coordinates for a granted geolocation permission. */
export interface GeoCoords {
  latitude: number;
  longitude: number;
}

/**
 * A named viewport descriptor, declared in `scout.config.json` `viewports` (or
 * shipped as a built-in). A `device` Playwright preset is the base; explicit
 * fields override it (`{ device: "iPhone 13", height: 844 }` = the preset with
 * its height pinned). `width`/`height` are required only when there is no
 * `device` to take them from. Resolved into Playwright context options by
 * `resolveViewport` at launch — never baked into the recorded script.
 */
export interface Viewport {
  /** Playwright device preset name (e.g. "iPhone 13"); the base for overrides. */
  device?: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
}

/**
 * One cookie applied to the browser context before the scenario runs. Resolved
 * fresh from the spec each run (profile default + per-scenario frontmatter /
 * override, merged by name) and set via Playwright `context.addCookies()` —
 * never a replayable Step, like storageState/permissions. `value` may carry a
 * `$ENV:VAR` placeholder, resolved at launch so the secret never lands in the
 * committed spec or the LLM context. `domain`/`path` default to the host of
 * `baseUrl` and `/` when omitted; `expires` is unix seconds (Playwright
 * convention) and omitting it yields a session cookie.
 */
export interface ScenarioCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Browser permission policy resolved from a scenario's spec (file frontmatter
 * is the default, per-section keys override it, merged per-axis). Three states
 * per permission: absent = native browser behavior (untouched); granted =
 * explicitly allowed; denied = explicitly blocked via an init-script stub so no
 * native prompt appears. `deny` only matters in headed runs (headless already
 * denies silently); `grant`/`geolocation` change behavior in both. Resolved
 * fresh from the spec each run — never baked into the recorded script (it is a
 * context-creation parameter, like storageState, not a replayable step).
 */
export interface PermissionPolicy {
  /** Permissions to grant explicitly (Playwright newContext `permissions`). */
  grant?: string[];
  /** Permissions to block via an init-script stub (kills the native prompt). */
  deny?: string[];
  /** Coordinates for a granted geolocation permission. */
  geolocation?: GeoCoords;
}

export type Step =
  | { kind: "navigate"; url: string }
  | { kind: "click"; target: Target }
  | { kind: "fill"; target: Target; value: string }
  | { kind: "select"; target: Target; value: string }
  | { kind: "press"; key: string }
  | { kind: "wheel"; deltaX: number; deltaY: number; x?: number; y?: number }
  | { kind: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: "waitForText"; text: string }
  | { kind: "waitForUrl"; pattern: string }
  | { kind: "assertVisible"; text: string }
  | { kind: "assertNotVisible"; text: string }
  | { kind: "assertUrl"; pattern: string }
  | ({ kind: "assertNetwork" } & NetworkMatcher)
  | { kind: "assertNoConsoleErrors"; ignore?: string[] }
  | { kind: "assertConsoleMessage"; includes: string[]; type?: string }
  | { kind: "switchTab"; urlGlob?: string }
  | { kind: "screenshot"; label: string };

export type Verdict = "verified" | "failed" | "partial" | "blocked";
export type ScenarioStatus = Verdict | "pending";

/**
 * A single verification scenario, parsed from a `.scout/specs/**\/*.scout.md`
 * file. The markdown is the source of truth and a *pure input* — it is never
 * mutated by a run. Status and last-run derive from `.scout/runs/` instead.
 */
export interface Scenario {
  /** Logical identity, unique across the suite: `<file-slug>/<scenario-slug>` */
  slug: string;
  /** Heading text of the scenario section */
  name: string;
  /** Natural-language description of the flow + expected behavior */
  scenario: string;
  /** Feature/group this scenario belongs to (frontmatter `feature` or filename) */
  feature: string;
  /** Auth profile name from scout.config.json (omit = anonymous) */
  profile?: string;
  /** Extra context handed to the AI agent */
  notes?: string;
  /** Free-form tags (file-level + per-scenario, merged) */
  tags?: string[];
  /**
   * Viewport names this scenario runs in (file frontmatter default, replaced —
   * not merged — by a per-section `viewports:` override). Each name must resolve
   * against the built-in/config registry. Omitted = the config's default
   * viewport. Declaring N names fans the scenario out into N verification units.
   */
  viewports?: string[];
  /** Browser permission policy (frontmatter default + per-section override). */
  permissions?: PermissionPolicy;
  /**
   * Cookies declared on the scenario (file frontmatter + per-section override,
   * merged by name). The profile's cookies are merged in at launch, under
   * these. Carries raw `$ENV:VAR` placeholders — resolved only at launch.
   */
  cookies?: ScenarioCookie[];
  /** Source spec file, relative to the project root */
  file: string;
}

export interface RunResult {
  slug: string;
  /** Viewport name this run executed in — part of the run identity (`slug@viewport`). */
  viewport: string;
  /** replay = cached deterministic steps; ai = agent-driven run */
  mode: "replay" | "ai";
  verdict: Verdict;
  reason: string;
  stepCount?: number;
  failedStep?: string;
  runDir: string;
  startedAt: string;
  durationMs: number;
  screenshots: string[];
  trace?: string;
  /** Paced demo clip (MP4, or WebM fallback) — only when --demo-video and verified */
  video?: string;
  /** true when this AI run replaced a broken cached script */
  healed?: boolean;
  /**
   * Set when the AI runner itself failed to obtain a verdict (infrastructure
   * failure: turn budget, SDK error). The verdict is "blocked" by convention,
   * but it is NOT a UI judgment — rerun instead of debugging the app.
   */
  runnerFailure?: string;
}
