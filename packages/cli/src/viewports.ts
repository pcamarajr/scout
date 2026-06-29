import { devices } from "playwright";
import type { ScoutConfig } from "./config.js";
import type { Scenario, Viewport } from "./types.js";

/**
 * A named viewport resolved into the browser-context parameters Playwright
 * needs. Produced by {@link resolveViewport} from a {@link Viewport} descriptor
 * (built-in or from config), spreading a `device` preset and letting explicit
 * fields win on top. `width`/`height` are always present; the rest are omitted
 * when neither the preset nor the descriptor sets them (Playwright defaults).
 */
export interface ResolvedViewport {
  /** The registry name — also the script-file token and report key. */
  name: string;
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
}

/** The built-in default when neither the scenario nor the config picks one. */
export const DEFAULT_VIEWPORT = "mobile";

/**
 * Curated viewports available without any config. A same-named entry in
 * `scout.config.json` `viewports` overrides one of these. `mobile` emulates an
 * iPhone 13 (touch + mobile UA + dsf 3) but pins the canonical 390×844 portrait
 * so the demo-video aspect stays stable across runs.
 */
export const BUILTIN_VIEWPORTS: Record<string, Viewport> = {
  mobile: { device: "iPhone 13", width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
  tablet: { device: "iPad Mini" },
};

/**
 * Viewport names double as filesystem tokens (`<slug>@<name>.json`) and report
 * keys, so they are constrained to a safe, stable charset — a typo or a name
 * with a path/`@` character fails loud instead of writing a broken script path.
 */
const VIEWPORT_NAME_RE = /^[a-z0-9-]+$/;

export function isValidViewportName(name: string): boolean {
  return VIEWPORT_NAME_RE.test(name);
}

/** The full viewport registry for a config: built-ins, overridden by config. */
export function viewportRegistry(config: ScoutConfig): Record<string, Viewport> {
  return { ...BUILTIN_VIEWPORTS, ...(config.viewports ?? {}) };
}

/** The default viewport name — config override, else the built-in. */
export function defaultViewportName(config: ScoutConfig): string {
  return config.defaultViewport ?? DEFAULT_VIEWPORT;
}

function knownNames(registry: Record<string, Viewport>): string {
  return Object.keys(registry).sort().join(", ");
}

/**
 * Resolve a named viewport into Playwright context options. Fail-loud on an
 * unknown name, a `device` preset Playwright doesn't ship, or a descriptor that
 * provides neither dimensions nor a preset to take them from.
 */
export function resolveViewport(name: string, config: ScoutConfig): ResolvedViewport {
  const registry = viewportRegistry(config);
  const vp = registry[name];
  if (!vp) {
    throw new Error(`Unknown viewport "${name}". Known viewports: ${knownNames(registry)}.`);
  }
  const base = vp.device ? devices[vp.device] : undefined;
  if (vp.device && !base) {
    throw new Error(
      `Viewport "${name}" references unknown Playwright device "${vp.device}". See https://playwright.dev/docs/emulation#devices for valid names.`
    );
  }
  const width = vp.width ?? base?.viewport.width;
  const height = vp.height ?? base?.viewport.height;
  if (width == null || height == null) {
    throw new Error(
      `Viewport "${name}" needs explicit width and height (or a "device" preset that provides them).`
    );
  }
  return {
    name,
    width,
    height,
    deviceScaleFactor: vp.deviceScaleFactor ?? base?.deviceScaleFactor,
    isMobile: vp.isMobile ?? base?.isMobile,
    hasTouch: vp.hasTouch ?? base?.hasTouch,
    userAgent: vp.userAgent ?? base?.userAgent,
  };
}

/**
 * The viewports a scenario runs in: the explicit per-invocation `override`
 * (ad-hoc, single), else the scenario's declared list, else the config default.
 * Names only — existence is validated at resolution time ({@link resolveViewport}).
 */
export function runnableViewports(
  scenario: Scenario,
  config: ScoutConfig,
  override?: string
): string[] {
  if (override) return [override];
  return scenario.viewports?.length ? scenario.viewports : [defaultViewportName(config)];
}

/** One (scenario × viewport) verification unit. */
export interface ScenarioViewport {
  scenario: Scenario;
  viewport: string;
}

/** Expand scenarios into their (scenario × viewport) units, for list/report. */
export function expandScenarios(scenarios: Scenario[], config: ScoutConfig): ScenarioViewport[] {
  return scenarios.flatMap((scenario) =>
    runnableViewports(scenario, config).map((viewport) => ({ scenario, viewport }))
  );
}

/** The store key for a (scenario × viewport) run: `<slug>@<viewport>`. */
export function runKey(slug: string, viewport: string): string {
  return `${slug}@${viewport}`;
}
