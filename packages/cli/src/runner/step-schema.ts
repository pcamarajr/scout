import { FAULT_RESOURCE_TYPES, type FaultResourceType, type NetworkFault, type Step } from "../types.js";

/** Every step kind a recorded script may contain — the closed `Step` union. */
export const STEP_KINDS: ReadonlySet<Step["kind"]> = new Set<Step["kind"]>([
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "wheel",
  "drag",
  "waitForText",
  "waitForUrl",
  "assertVisible",
  "assertNotVisible",
  "assertState",
  "assertUrl",
  "assertNetwork",
  "assertNoConsoleErrors",
  "assertConsoleMessage",
  "switchTab",
  "failNetwork",
  "screenshot",
]);

/** Status a `failNetwork` step in mode "status" fulfills with when none is given. */
export const DEFAULT_FAULT_STATUS = 503;

const RESOURCE_TYPES = new Set<string>(FAULT_RESOURCE_TYPES);

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * Validates and normalizes a `failNetwork` fault — from a recorded script, a
 * hand-edited one, or the agent tool. Fails loud with the offending field so a
 * typo can never become a silent no-op. Normalization makes the recorded form
 * explicit and replay-stable: `times: 1` when no scope was given, and the
 * default status written out for mode "status".
 */
export function normalizeNetworkFault(raw: unknown, ctx = "failNetwork"): NetworkFault {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${ctx}: expected an object.`);
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.urlGlob !== "string" || !o.urlGlob.trim()) {
    throw new Error(`${ctx}: "urlGlob" must be a non-empty string (e.g. "**/*.{ts,m4s}").`);
  }
  if (o.mode !== "abort" && o.mode !== "status") {
    throw new Error(`${ctx}: "mode" must be "abort" or "status", got ${JSON.stringify(o.mode)}.`);
  }
  if (o.status !== undefined) {
    if (o.mode !== "status") throw new Error(`${ctx}: "status" is only allowed with mode "status".`);
    if (!Number.isInteger(o.status) || (o.status as number) < 400 || (o.status as number) > 599) {
      throw new Error(`${ctx}: "status" must be an HTTP error code (400-599), got ${JSON.stringify(o.status)}.`);
    }
  }
  if (o.times !== undefined && o.durationMs !== undefined) {
    throw new Error(`${ctx}: set exactly one of "times" or "durationMs", not both.`);
  }
  if (o.times !== undefined && !isPositiveInt(o.times)) {
    throw new Error(`${ctx}: "times" must be a positive integer, got ${JSON.stringify(o.times)}.`);
  }
  if (o.durationMs !== undefined && !isPositiveInt(o.durationMs)) {
    throw new Error(`${ctx}: "durationMs" must be a positive integer, got ${JSON.stringify(o.durationMs)}.`);
  }
  let resourceTypes: FaultResourceType[] | undefined;
  if (o.resourceTypes !== undefined) {
    if (!Array.isArray(o.resourceTypes) || !o.resourceTypes.length) {
      throw new Error(`${ctx}: "resourceTypes" must be a non-empty array when set.`);
    }
    for (const t of o.resourceTypes) {
      if (typeof t !== "string" || !RESOURCE_TYPES.has(t)) {
        throw new Error(
          `${ctx}: unknown resource type ${JSON.stringify(t)}. Allowed: ${FAULT_RESOURCE_TYPES.join(", ")}.`
        );
      }
    }
    resourceTypes = [...new Set(o.resourceTypes as FaultResourceType[])];
  }
  const known = new Set(["kind", "urlGlob", "mode", "status", "times", "durationMs", "resourceTypes"]);
  const unknown = Object.keys(o).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`${ctx}: unknown field(s) ${unknown.join(", ")}.`);

  return {
    urlGlob: o.urlGlob,
    mode: o.mode,
    ...(o.mode === "status" ? { status: (o.status as number | undefined) ?? DEFAULT_FAULT_STATUS } : {}),
    ...(o.durationMs !== undefined ? { durationMs: o.durationMs as number } : { times: (o.times as number | undefined) ?? 1 }),
    ...(resourceTypes ? { resourceTypes } : {}),
  };
}

/**
 * Parses a recorded script (`.scout/scripts/<slug>@<viewport>.json`). Every
 * step must name a known kind — an unknown one used to fall through replay as
 * a silent pass — and `failNetwork` steps are fully validated. Other kinds are
 * passed through as recorded, so existing scripts load unchanged.
 */
export function parseSteps(raw: unknown, source = "script"): Step[] {
  if (!Array.isArray(raw)) throw new Error(`${source}: a script must be a JSON array of steps.`);
  return raw.map((step, i) => {
    const ctx = `${source} step ${i + 1}`;
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`${ctx}: expected an object.`);
    }
    const kind = (step as { kind?: unknown }).kind;
    if (typeof kind !== "string" || !STEP_KINDS.has(kind as Step["kind"])) {
      throw new Error(`${ctx}: unknown step kind ${JSON.stringify(kind)}. Known: ${[...STEP_KINDS].join(", ")}.`);
    }
    if (kind === "failNetwork") return { kind, ...normalizeNetworkFault(step, `${ctx} (failNetwork)`) };
    return step as Step;
  });
}
