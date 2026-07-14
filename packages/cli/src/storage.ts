import type { ScenarioStorage } from "./types.js";

/**
 * Web-storage seeding is declarative: it is config of a scenario (profile
 * default + file frontmatter/override, merged per key per namespace), applied
 * to the Playwright context via an init-script that runs before any page script
 * — never a replayable Step, just like `cookies`/`storageState`/`permissions`.
 * A value may carry a `$ENV:VAR` placeholder, resolved only at launch so the
 * secret never lands in the committed spec nor the LLM context.
 *
 * Validation is curated (not a pass-through): only `local`, `session` and
 * `remove` are allowed, with the right shapes; an unknown field or a bad type
 * fails loudly at parse time instead of silently becoming a no-op — the same
 * house rule as the cookie/permission allowlists.
 */

const ALLOWED_KEYS = new Set(["local", "session", "remove"]);

/** Validate + normalize one string→string record (`local` / `session`). */
function validateRecord(raw: unknown, field: string, ctx: string): Record<string, string> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Storage "${field}" in ${ctx} must be a map of string keys to string values.`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim()) throw new Error(`Storage "${field}" in ${ctx} has an empty key.`);
    if (typeof value !== "string") {
      throw new Error(`Storage "${field}.${key}" in ${ctx} must be a string value (got ${typeof value}).`);
    }
    out[key] = value;
  }
  return out;
}

/** Validate + normalize a storage object (YAML frontmatter or profile config). */
export function validateStorage(raw: unknown, ctx: string): ScenarioStorage {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Invalid storage in ${ctx}: expected an object with "local", "session" and/or "remove".`
    );
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Unknown storage field "${key}" in ${ctx}. Allowed: ${[...ALLOWED_KEYS].join(", ")}.`);
    }
  }
  const storage: ScenarioStorage = {};
  if (o.local !== undefined) storage.local = validateRecord(o.local, "local", ctx);
  if (o.session !== undefined) storage.session = validateRecord(o.session, "session", ctx);
  if (o.remove !== undefined) {
    if (!Array.isArray(o.remove) || o.remove.some((k) => typeof k !== "string" || !k.trim())) {
      throw new Error(`Storage "remove" in ${ctx} must be a list of non-empty string keys.`);
    }
    storage.remove = [...new Set(o.remove as string[])];
  }
  return storage;
}

/**
 * Parse the YAML `storage:` block (frontmatter / profile) — an object with any
 * of `local`, `session`, `remove`. Returns undefined when absent.
 */
export function parseStorageBlock(raw: unknown, ctx: string): ScenarioStorage | undefined {
  if (raw == null) return undefined;
  return validateStorage(raw, ctx);
}

/**
 * Parse the per-`##` override form: a single line of comma-separated tokens,
 * each one of `local.<key>=<value>`, `session.<key>=<value>` or `remove=<key>`.
 * The line-based override can't carry a nested YAML object, so the namespace is
 * spelled inline. E.g. `storage: local.hn_app_open_count=3, remove=hn_pwa_prompt_dismissed`.
 * Values with a literal comma aren't expressible here — use the frontmatter form.
 */
export function parseInlineStorage(raw: string, ctx: string): ScenarioStorage {
  const tokens = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!tokens.length) {
    throw new Error(
      `Empty "storage" override in ${ctx}. Use: storage: local.key=value[, session.k=v, remove=key].`
    );
  }
  const storage: ScenarioStorage = { local: {}, session: {}, remove: [] };
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `Invalid storage token "${token}" in ${ctx}. Expected local.key=value, session.key=value or remove=key.`
      );
    }
    const lhs = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim();
    if (lhs === "remove") {
      if (!value) throw new Error(`Invalid storage token "${token}" in ${ctx}: empty key to remove.`);
      storage.remove!.push(value);
      continue;
    }
    const dot = lhs.indexOf(".");
    const ns = dot > 0 ? lhs.slice(0, dot) : "";
    const key = dot > 0 ? lhs.slice(dot + 1).trim() : "";
    if ((ns !== "local" && ns !== "session") || !key) {
      throw new Error(
        `Invalid storage token "${token}" in ${ctx}. Expected local.key=value, session.key=value or remove=key.`
      );
    }
    storage[ns]![key] = value;
  }
  // Drop empty namespaces so a merge/emptiness check stays clean.
  if (!Object.keys(storage.local!).length) delete storage.local;
  if (!Object.keys(storage.session!).length) delete storage.session;
  if (!storage.remove!.length) delete storage.remove;
  return storage;
}

/**
 * Merge two storage objects; `override` wins per key per namespace, `remove`
 * lists concatenate + dedupe. Empty namespaces are dropped from the result.
 */
export function mergeStorage(base: ScenarioStorage, override: ScenarioStorage): ScenarioStorage {
  const local = { ...(base.local ?? {}), ...(override.local ?? {}) };
  const session = { ...(base.session ?? {}), ...(override.session ?? {}) };
  const remove = [...new Set([...(base.remove ?? []), ...(override.remove ?? [])])];
  const merged: ScenarioStorage = {};
  if (Object.keys(local).length) merged.local = local;
  if (Object.keys(session).length) merged.session = session;
  if (remove.length) merged.remove = remove;
  return merged;
}

/** True when a storage object seeds or removes nothing (so it can be treated as absent). */
export function isEmptyStorage(storage: ScenarioStorage | undefined): boolean {
  if (!storage) return true;
  return (
    !Object.keys(storage.local ?? {}).length &&
    !Object.keys(storage.session ?? {}).length &&
    !(storage.remove?.length ?? 0)
  );
}
