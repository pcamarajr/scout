import type { ScenarioCookie } from "./types.js";

/**
 * Cookie support is declarative: cookies are config of a scenario (profile
 * default + per-scenario frontmatter/override, merged by name), applied to the
 * Playwright context via `context.addCookies()` before the flow runs — never a
 * replayable Step, just like `storageState`/`permissions`. `value` may carry a
 * `$ENV:VAR` placeholder, resolved only at launch so the secret never lands in
 * the committed spec nor the LLM context.
 *
 * Validation is curated (not a pass-through to Playwright): unknown fields and
 * a bad `sameSite` fail loudly at parse time instead of silently becoming a
 * no-op — the same house rule as the permission allowlist.
 */

const SAME_SITE = new Set(["Strict", "Lax", "None"]);
const ALLOWED_KEYS = new Set([
  "name",
  "value",
  "domain",
  "path",
  "expires",
  "httpOnly",
  "secure",
  "sameSite",
]);

/** Validate + normalize one cookie object (YAML frontmatter or profile config). */
export function validateCookie(raw: unknown, ctx: string): ScenarioCookie {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid cookie in ${ctx}: expected an object with at least "name" and "value".`);
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Unknown cookie field "${key}" in ${ctx}. Allowed: ${[...ALLOWED_KEYS].join(", ")}.`);
    }
  }
  if (typeof o.name !== "string" || !o.name.trim()) {
    throw new Error(`Cookie in ${ctx} needs a non-empty string "name".`);
  }
  if (typeof o.value !== "string") {
    throw new Error(`Cookie "${o.name}" in ${ctx} needs a string "value".`);
  }
  const cookie: ScenarioCookie = { name: o.name, value: o.value };
  if (o.domain !== undefined) {
    if (typeof o.domain !== "string" || !o.domain.trim()) {
      throw new Error(`Cookie "${o.name}" in ${ctx}: "domain" must be a non-empty string.`);
    }
    cookie.domain = o.domain;
  }
  if (o.path !== undefined) {
    if (typeof o.path !== "string" || !o.path.trim()) {
      throw new Error(`Cookie "${o.name}" in ${ctx}: "path" must be a non-empty string.`);
    }
    cookie.path = o.path;
  }
  if (o.expires !== undefined) {
    if (typeof o.expires !== "number" || !Number.isFinite(o.expires)) {
      throw new Error(`Cookie "${o.name}" in ${ctx}: "expires" must be a number (unix seconds).`);
    }
    cookie.expires = o.expires;
  }
  if (o.httpOnly !== undefined) {
    if (typeof o.httpOnly !== "boolean") {
      throw new Error(`Cookie "${o.name}" in ${ctx}: "httpOnly" must be a boolean.`);
    }
    cookie.httpOnly = o.httpOnly;
  }
  if (o.secure !== undefined) {
    if (typeof o.secure !== "boolean") {
      throw new Error(`Cookie "${o.name}" in ${ctx}: "secure" must be a boolean.`);
    }
    cookie.secure = o.secure;
  }
  if (o.sameSite !== undefined) {
    if (typeof o.sameSite !== "string" || !SAME_SITE.has(o.sameSite)) {
      throw new Error(`Cookie "${o.name}" in ${ctx}: "sameSite" must be one of Strict, Lax, None.`);
    }
    cookie.sameSite = o.sameSite as ScenarioCookie["sameSite"];
  }
  return cookie;
}

/** Parse the YAML `cookies:` block (frontmatter / profile) — a list of objects. */
export function parseCookieList(raw: unknown, ctx: string): ScenarioCookie[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`"cookies" in ${ctx} must be a list of cookie objects, e.g. [{ name: foo, value: bar }].`);
  }
  return raw.map((c, i) => validateCookie(c, `${ctx} cookie #${i + 1}`));
}

/**
 * Parse the per-`##` override form: a single line `cookies: name=value[, n2=v2]`.
 * Only `name=value` (no attributes) — the line-based override parser can't carry
 * a YAML object; attributes belong in the file frontmatter / profile. Values
 * with a literal comma aren't expressible here — use the frontmatter form.
 */
export function parseInlineCookies(raw: string, ctx: string): ScenarioCookie[] {
  const pairs = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!pairs.length) {
    throw new Error(`Empty "cookies" override in ${ctx}. Use: cookies: name=value[, n2=v2].`);
  }
  return pairs.map((pair) => {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid cookie "${pair}" in ${ctx}. Expected name=value.`);
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) throw new Error(`Invalid cookie "${pair}" in ${ctx}: empty name.`);
    return { name, value };
  });
}

/** Merge two cookie lists by name; `override` wins over `base`, order preserved. */
export function mergeCookiesByName(
  base: ScenarioCookie[],
  override: ScenarioCookie[]
): ScenarioCookie[] {
  const byName = new Map<string, ScenarioCookie>();
  for (const c of base) byName.set(c.name, c);
  for (const c of override) byName.set(c.name, c);
  return [...byName.values()];
}
