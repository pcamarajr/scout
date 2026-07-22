/**
 * How a recorded step finds its element on replay. A Target is derived at record
 * time by the selector preference ladder (see `runner/selector-ladder.ts`): the
 * most stable strategy that *uniquely* matched the live element becomes the
 * primary location fields, the other unique strategies are kept as ordered
 * {@link Target.fallbacks}, and {@link Target.fragile} flags the case where only
 * a positional CSS path was available. Exactly one primary strategy is set:
 * `testId`, `role`+`name`, `text`, or `css`.
 */
export interface Target {
  /** ARIA role + accessible name — resilient to DOM refactors */
  role?: string;
  name?: string;
  /** CSS path — a stable `id` selector or, as a last resort, a positional path */
  css?: string;
  /**
   * data-testid (or the configured testid attribute) — the sturdiest handle:
   * stable across DOM refactors and the strategy for elements OUTSIDE the
   * accessibility tree (a gesture layer, an overlay `<div>` with no role/name).
   * Resolved via Playwright's `getByTestId`. Top rung of the ladder.
   */
  testId?: string;
  /**
   * Visible-text anchor — resolved via Playwright's `getByText` (exact). Used
   * when an element has no testid/id/role+name but a stable, unique visible
   * label. Below role+name on the ladder, above a positional CSS path.
   */
  text?: string;
  /**
   * True when the primary strategy is a POSITIONAL CSS path (the ladder bottomed
   * out) — the recorded step is fragile: it replays today but breaks as soon as
   * the DOM shifts. Surfaced as a warning at record time and in the run report so
   * a stable handle (a data-testid, a unique role/name) can be added.
   */
  fragile?: boolean;
  /**
   * Other ladder strategies that ALSO uniquely matched the element at record
   * time, ordered most-stable first. On replay, if the primary strategy no
   * longer resolves, these are tried in order — deterministically, with no LLM
   * ("--no-heal" semantics preserved). Absent on steps recorded before this
   * feature (backward compatible) and when no alternative uniquely matched.
   */
  fallbacks?: Target[];
  /** Human-readable label for reports */
  description: string;
}

/**
 * Matcher for a state assertion on an element found by a {@link Target}. Asserts
 * VISUAL/structural state that text- and URL-based checks can't reach: a class
 * token, an attribute, or a computed style. Its reason for being is the opacity
 * toggle pattern — a control kept in the DOM but hidden with `opacity:0`, which
 * Playwright's visibility (and therefore `assertNotVisible`) still counts as
 * VISIBLE. Assert `opacity-0`/computed `opacity === "0"` instead. Every provided
 * check must hold; polled until they do or the timeout elapses, so it is
 * deterministic on replay.
 */
export interface ElementStateMatcher {
  /** A class token that MUST be present (e.g. "opacity-0"). Membership, not full-string equality. */
  hasClass?: string;
  /** A class token that must NOT be present (e.g. "opacity-100"). */
  notHasClass?: string;
  /** An attribute that must be present; with `value`, it must equal `value`. */
  attribute?: { name: string; value?: string };
  /** A computed style that must equal `value` (e.g. property "opacity", value "0"). */
  computedStyle?: { property: string; value: string };
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

/** Explicit viewport dimensions for device emulation. */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Per-scenario device / user-agent emulation, resolved from a scenario's spec
 * (profile default + file frontmatter + per-`##` override, merged per field;
 * scenario wins over profile). It is a context-creation parameter — re-resolved
 * fresh from the spec each run and applied at `browser.newContext()` — NEVER a
 * recordable Step, so replay re-reads the frontmatter and stays deterministic
 * (like storageState/cookies/permissions).
 *
 * Its reason for being is UI gated on user-agent / device detection — an
 * "Add to Home Screen" sheet that only renders under an iOS-Safari UA, a layout
 * branch that keys off `navigator.maxTouchPoints`. Without it the runner always
 * launches desktop Chromium with its default UA, so those flows can never pass.
 *
 * `device` names a Playwright device descriptor (a key of the `devices`
 * registry, e.g. "iPhone 14"), validated against the registry at parse time.
 * The individual fields (`userAgent`, `viewport`, `deviceScaleFactor`,
 * `isMobile`, `hasTouch`) compose on top of (or without) `device` — an
 * explicit field always wins over the named device's value. None of these are
 * secrets, so no `$ENV:VAR` resolution is applied (unlike cookies/storage).
 */
export interface ScenarioDevice {
  /** Playwright device registry key (e.g. "iPhone 14"); the base for overrides. */
  device?: string;
  /** User-agent string; wins over the named device's UA. */
  userAgent?: string;
  /** Viewport dimensions; win over the named device's viewport. */
  viewport?: ViewportSize;
  /** Device scale factor; wins over the named device's value. */
  deviceScaleFactor?: number;
  /** Whether to emulate a mobile device (meta viewport, touch events). */
  isMobile?: boolean;
  /** Whether the device supports touch. */
  hasTouch?: boolean;
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
 * Web storage seeded into the browser context before the app loads, resolved
 * from a scenario's spec (profile default + file frontmatter + per-section
 * override, merged per key per namespace; `remove` concatenated). It is a
 * context-creation parameter — re-resolved fresh from the spec each run and
 * applied via an init-script that runs before any page script, so the seed is
 * in place before the app reads it. It is NEVER a recorded/replayable Step and
 * never lands in the committed script JSON (like storageState/cookies).
 *
 * Use it to make verifiable a feature whose trigger lives in storage: a "seen"
 * flag, an open-count threshold, a dismissed prompt. Values may carry a
 * `$ENV:VAR` placeholder, resolved only at launch. `remove` clears keys from
 * BOTH localStorage and sessionStorage, guaranteeing a clean precondition.
 */
export interface ScenarioStorage {
  /** localStorage key→value pairs to seed (value may be a `$ENV:VAR`). */
  local?: Record<string, string>;
  /** sessionStorage key→value pairs to seed (value may be a `$ENV:VAR`). */
  session?: Record<string, string>;
  /** Keys removed from both localStorage and sessionStorage before the seed. */
  remove?: string[];
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
  | { kind: "waitForText"; text: string; timeout?: number }
  | { kind: "waitForUrl"; pattern: string; timeout?: number }
  | { kind: "assertVisible"; text: string; timeout?: number; oneShot?: boolean }
  | { kind: "assertNotVisible"; text: string; timeout?: number }
  | ({ kind: "assertState"; target: Target; timeout?: number } & ElementStateMatcher)
  | { kind: "assertUrl"; pattern: string; timeout?: number }
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
  /**
   * Web storage seeded on the scenario (profile default + file frontmatter +
   * per-section override, merged per key per namespace). A context-creation
   * parameter re-resolved each run, applied before the app loads — never baked
   * into the recorded script. Carries raw `$ENV:VAR` placeholders — resolved
   * only at launch.
   */
  storage?: ScenarioStorage;
  /**
   * Device / user-agent emulation for the scenario (profile default + file
   * frontmatter + per-section override, merged per field). A context-creation
   * parameter re-resolved each run and applied at `newContext()` — never baked
   * into the recorded script. Composes over the resolved viewport: the device's
   * fields win over the viewport's for UA/metrics/size.
   */
  device?: ScenarioDevice;
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
  /**
   * Interaction steps whose recorded selector is a positional CSS path (the
   * ladder bottomed out). Populated from the persisted/verified script so the
   * fragility is visible at record time (CLI output + report), not discovered on
   * a broken replay days later. Empty/absent when every step has a stable handle.
   */
  fragileSteps?: FragileStep[];
  /**
   * Notes emitted during deterministic replay when a step's primary selector no
   * longer resolved and a recorded fallback did — no LLM involved. Absent when
   * no fallback was needed (the common case).
   */
  usedFallbacks?: string[];
}

/** One recorded step that replays on a fragile positional selector. */
export interface FragileStep {
  /** 1-based position of the step in the recorded script. */
  step: number;
  /** Human-readable description of the step (from `describeStep`). */
  description: string;
}
