import { devices } from "playwright";
import type { ResolvedViewport } from "./viewports.js";
import type { ScenarioDevice, ViewportSize } from "./types.js";

/**
 * Device / user-agent emulation is declarative: it is config of a scenario
 * (profile default + file frontmatter/override, merged per field), applied to
 * the Playwright context at `newContext()` — never a replayable Step, just like
 * `cookies`/`storageState`/`permissions`. Because it is re-resolved from the
 * spec on every run, replay re-reads the frontmatter and stays deterministic.
 *
 * A `device` names a Playwright device descriptor (a key of the `devices`
 * registry, e.g. "iPhone 14"). It is validated against the registry at PARSE
 * time — an unknown device is a hard error, not a silent no-op — the same house
 * rule as the cookie/permission/viewport allowlists. The individual fields
 * (`userAgent`, `viewport`, `deviceScaleFactor`, `isMobile`, `hasTouch`)
 * compose on top of (or without) the named device; an explicit field always
 * wins over the device's value.
 *
 * None of these fields are secrets, so — unlike cookies/storage — no `$ENV:VAR`
 * resolution is applied (consistent with how other non-secret launch options,
 * e.g. viewport dimensions, are handled).
 */

const ALLOWED_KEYS = new Set([
  "device",
  "userAgent",
  "viewport",
  "deviceScaleFactor",
  "isMobile",
  "hasTouch",
]);

/** True when a Playwright device descriptor of this name ships in the registry. */
export function isKnownDevice(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(devices, name);
}

/** Fail-loud message for an unknown device name, pointing at the registry docs. */
function unknownDevice(name: string, ctx: string): Error {
  return new Error(
    `Unknown Playwright device "${name}" in ${ctx}. See https://playwright.dev/docs/emulation#devices for valid names.`
  );
}

/** Validate + normalize an explicit viewport-size object. */
function validateViewportSize(raw: unknown, ctx: string): ViewportSize {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Device "viewport" in ${ctx} must be an object { width, height }.`);
  }
  const o = raw as Record<string, unknown>;
  const width = o.width;
  const height = o.height;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
    throw new Error(`Device "viewport.width" in ${ctx} must be a positive number.`);
  }
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
    throw new Error(`Device "viewport.height" in ${ctx} must be a positive number.`);
  }
  return { width, height };
}

/**
 * Validate + normalize a device object (YAML frontmatter or profile config).
 * Curated: unknown fields, a bad shape, or an unknown `device` name fail loudly
 * at parse time instead of silently becoming a no-op.
 */
export function validateDevice(raw: unknown, ctx: string): ScenarioDevice {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Invalid device in ${ctx}: expected an object with "device" and/or "userAgent", "viewport", "deviceScaleFactor", "isMobile", "hasTouch".`
    );
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Unknown device field "${key}" in ${ctx}. Allowed: ${[...ALLOWED_KEYS].join(", ")}.`);
    }
  }
  const device: ScenarioDevice = {};
  if (o.device !== undefined) {
    if (typeof o.device !== "string" || !o.device.trim()) {
      throw new Error(`Device "device" in ${ctx} must be a non-empty string (a Playwright device name).`);
    }
    if (!isKnownDevice(o.device)) throw unknownDevice(o.device, ctx);
    device.device = o.device;
  }
  if (o.userAgent !== undefined) {
    if (typeof o.userAgent !== "string" || !o.userAgent.trim()) {
      throw new Error(`Device "userAgent" in ${ctx} must be a non-empty string.`);
    }
    device.userAgent = o.userAgent;
  }
  if (o.viewport !== undefined) {
    device.viewport = validateViewportSize(o.viewport, ctx);
  }
  if (o.deviceScaleFactor !== undefined) {
    if (typeof o.deviceScaleFactor !== "number" || !Number.isFinite(o.deviceScaleFactor) || o.deviceScaleFactor <= 0) {
      throw new Error(`Device "deviceScaleFactor" in ${ctx} must be a positive number.`);
    }
    device.deviceScaleFactor = o.deviceScaleFactor;
  }
  if (o.isMobile !== undefined) {
    if (typeof o.isMobile !== "boolean") {
      throw new Error(`Device "isMobile" in ${ctx} must be a boolean.`);
    }
    device.isMobile = o.isMobile;
  }
  if (o.hasTouch !== undefined) {
    if (typeof o.hasTouch !== "boolean") {
      throw new Error(`Device "hasTouch" in ${ctx} must be a boolean.`);
    }
    device.hasTouch = o.hasTouch;
  }
  return device;
}

/**
 * Parse the YAML `device:` block (frontmatter / profile) — an object with a
 * `device` name and/or individual overrides. Returns undefined when absent or
 * empty (so a merge/emptiness check stays clean).
 */
export function parseDeviceBlock(raw: unknown, ctx: string): ScenarioDevice | undefined {
  if (raw == null) return undefined;
  const device = validateDevice(raw, ctx);
  return isEmptyDevice(device) ? undefined : device;
}

/**
 * Parse the per-`##` override form: a single line `device: <device name>`. The
 * line-based override can't carry a YAML object, so it names a device only —
 * individual overrides (userAgent, viewport, …) belong in the file frontmatter
 * or profile. The name is validated against the registry, like the block form.
 */
export function parseInlineDevice(raw: string, ctx: string): ScenarioDevice {
  const name = raw.trim();
  if (!name) {
    throw new Error(`Empty "device" override in ${ctx}. Use: device: <device name> (e.g. device: iPhone 14).`);
  }
  if (!isKnownDevice(name)) throw unknownDevice(name, ctx);
  return { device: name };
}

/**
 * Merge two device configs; `override` wins per field. `viewport` is replaced
 * wholesale (it is a width/height pair, not merged field-by-field). Returns
 * undefined when the merge seeds nothing, so callers can treat it as absent.
 */
export function mergeDevice(
  base: ScenarioDevice | undefined,
  override: ScenarioDevice | undefined
): ScenarioDevice | undefined {
  if (!base && !override) return undefined;
  const merged: ScenarioDevice = { ...(base ?? {}), ...(override ?? {}) };
  return isEmptyDevice(merged) ? undefined : merged;
}

/** True when a device config sets nothing (so it can be treated as absent). */
export function isEmptyDevice(device: ScenarioDevice | undefined): boolean {
  if (!device) return true;
  return (
    device.device === undefined &&
    device.userAgent === undefined &&
    device.viewport === undefined &&
    device.deviceScaleFactor === undefined &&
    device.isMobile === undefined &&
    device.hasTouch === undefined
  );
}

/**
 * The Playwright context-option fields a resolved device contributes. Any field
 * left undefined means "the device does not set this" — the caller falls back
 * to the viewport's value.
 */
export interface ResolvedDeviceOptions {
  viewport?: ViewportSize;
  userAgent?: string;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
}

/**
 * Resolve a device config into Playwright context-option fields: spread the
 * named `device` preset, then let explicit fields win on top. Fails loud on a
 * `device` the registry doesn't ship (a defensive re-check — the name is also
 * validated at parse time).
 */
export function resolveDeviceOptions(device: ScenarioDevice): ResolvedDeviceOptions {
  const base = device.device ? devices[device.device] : undefined;
  if (device.device && !base) throw unknownDevice(device.device, "device");
  return {
    viewport: device.viewport ?? base?.viewport,
    userAgent: device.userAgent ?? base?.userAgent,
    deviceScaleFactor: device.deviceScaleFactor ?? base?.deviceScaleFactor,
    isMobile: device.isMobile ?? base?.isMobile,
    hasTouch: device.hasTouch ?? base?.hasTouch,
  };
}

/**
 * The effective context size: the device's viewport when it sets one, else the
 * named viewport's dimensions. Used both to size the context and the recorded
 * demo video, so the two never diverge when a device overrides the size.
 */
export function effectiveViewportSize(
  viewport: ResolvedViewport,
  device: ScenarioDevice | undefined
): ViewportSize {
  const opts = device ? resolveDeviceOptions(device) : undefined;
  return opts?.viewport ?? { width: viewport.width, height: viewport.height };
}
