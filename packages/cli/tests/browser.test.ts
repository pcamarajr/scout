import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSelectorTarget,
  buildStorageInitScript,
  demoCursorStub,
  describeStateMismatch,
  resolveEnvValue,
  toPlaywrightCookie,
} from "../src/runner/browser.js";

// resolveEnvValue powers both browser_fill values AND browser_navigate URLs:
// secrets/tokens live as $ENV:VAR in the committed script and resolve at runtime.

test("resolveEnvValue substitutes a placeholder with the env value", () => {
  process.env.SCOUT_TEST_TOKEN = "abc123";
  assert.equal(resolveEnvValue("/renew?token=$ENV:SCOUT_TEST_TOKEN"), "/renew?token=abc123");
  delete process.env.SCOUT_TEST_TOKEN;
});

test("resolveEnvValue resolves multiple placeholders in one string", () => {
  process.env.SCOUT_TEST_A = "x";
  process.env.SCOUT_TEST_B = "y";
  assert.equal(resolveEnvValue("$ENV:SCOUT_TEST_A/$ENV:SCOUT_TEST_B"), "x/y");
  delete process.env.SCOUT_TEST_A;
  delete process.env.SCOUT_TEST_B;
});

test("resolveEnvValue leaves strings without placeholders untouched", () => {
  assert.equal(resolveEnvValue("/login"), "/login");
});

// The demo cursor is a best-effort overlay baked into the video. The critical
// invariant is that it can NEVER intercept the real click — hence pointer-events:none.
test("demoCursorStub injects a cursor API that cannot intercept clicks", () => {
  const stub = demoCursorStub();
  assert.match(stub, /window\.__scoutCursor/);
  assert.match(stub, /move\s*\(/);
  assert.match(stub, /pulse\s*\(/);
  assert.match(stub, /pointer-events:none/);
  // top-frame guard so the cursor isn't duplicated into iframes
  assert.match(stub, /window\.top !== window\.self/);
});

test("resolveEnvValue throws when the referenced env var is undefined", () => {
  delete process.env.SCOUT_TEST_MISSING;
  assert.throws(() => resolveEnvValue("/x?t=$ENV:SCOUT_TEST_MISSING"), /SCOUT_TEST_MISSING/);
});

// toPlaywrightCookie derives url/domain from baseUrl and resolves $ENV in value.

test("toPlaywrightCookie derives url from baseUrl when no domain/path given", () => {
  const c = toPlaywrightCookie({ name: "v", value: "B" }, "https://app.example.com/checkout");
  assert.deepEqual(c, { name: "v", value: "B", url: "https://app.example.com/checkout" });
});

test("toPlaywrightCookie uses baseUrl host + given path when only path is set", () => {
  const c = toPlaywrightCookie({ name: "v", value: "B", path: "/admin" }, "https://app.example.com/");
  assert.deepEqual(c, { name: "v", value: "B", domain: "app.example.com", path: "/admin" });
});

test("toPlaywrightCookie passes explicit domain through with a default path", () => {
  const c = toPlaywrightCookie({ name: "v", value: "B", domain: ".example.com" }, "https://app.example.com/");
  assert.deepEqual(c, { name: "v", value: "B", domain: ".example.com", path: "/" });
});

test("toPlaywrightCookie resolves $ENV in the value and carries attributes", () => {
  process.env.SCOUT_TEST_COOKIE = "secret-token";
  const c = toPlaywrightCookie(
    { name: "session", value: "$ENV:SCOUT_TEST_COOKIE", httpOnly: true, secure: true, sameSite: "Strict", expires: 1893456000 },
    "https://app.example.com/"
  );
  assert.deepEqual(c, {
    name: "session",
    value: "secret-token",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    expires: 1893456000,
    url: "https://app.example.com/",
  });
  delete process.env.SCOUT_TEST_COOKIE;
});

// buildStorageInitScript seeds local/session and clears removed keys, resolving
// $ENV in values — it must never throw inside a storage-less context.

test("buildStorageInitScript sets local + session and removes keys from both", () => {
  const script = buildStorageInitScript({
    local: { count: "3" },
    session: { flag: "on" },
    remove: ["dismissed"],
  });
  assert.match(script, /localStorage\.setItem/);
  assert.match(script, /sessionStorage\.setItem/);
  assert.match(script, /localStorage\.removeItem/);
  assert.match(script, /sessionStorage\.removeItem/);
  // values are embedded as JSON literals
  assert.match(script, /"count":"3"/);
  assert.match(script, /"flag":"on"/);
  assert.match(script, /"dismissed"/);
  // every access is guarded so a storage-less context can't throw
  assert.match(script, /try \{/);
});

test("buildStorageInitScript resolves $ENV in values (never persisted resolved)", () => {
  process.env.SCOUT_TEST_STORAGE = "secret-token";
  const script = buildStorageInitScript({ local: { token: "$ENV:SCOUT_TEST_STORAGE" } });
  assert.match(script, /"token":"secret-token"/);
  assert.doesNotMatch(script, /\$ENV:/);
  delete process.env.SCOUT_TEST_STORAGE;
});

test("buildStorageInitScript throws when a referenced env var is undefined", () => {
  delete process.env.SCOUT_TEST_STORAGE_MISSING;
  assert.throws(
    () => buildStorageInitScript({ local: { t: "$ENV:SCOUT_TEST_STORAGE_MISSING" } }),
    /SCOUT_TEST_STORAGE_MISSING/
  );
});

test("buildStorageInitScript returns empty string when nothing is seeded or removed", () => {
  assert.equal(buildStorageInitScript({}), "");
  assert.equal(buildStorageInitScript({ local: {}, session: {}, remove: [] }), "");
});

// buildSelectorTarget maps a raw {testId|css} to a durable Target — testId wins,
// and a missing selector throws so a selector click/assert can't target nothing.

test("buildSelectorTarget prefers testId and builds a data-testid description", () => {
  assert.deepEqual(buildSelectorTarget({ testId: "tap-layer" }), {
    testId: "tap-layer",
    description: '[data-testid="tap-layer"]',
  });
});

test("buildSelectorTarget falls back to css when there is no testId", () => {
  assert.deepEqual(buildSelectorTarget({ css: ".overlay .tap" }), {
    css: ".overlay .tap",
    description: ".overlay .tap",
  });
  // testId wins when both are present.
  assert.deepEqual(buildSelectorTarget({ testId: "t", css: ".c" }), {
    testId: "t",
    description: '[data-testid="t"]',
  });
});

test("buildSelectorTarget throws when neither testId nor css is given", () => {
  assert.throws(() => buildSelectorTarget({}), /needs testId or css/);
});

// describeStateMismatch is the pure comparator behind assertState's poll: "" when
// every provided check holds, else a reason for the first failing one. This is
// what makes the opacity-toggle pattern assertable (opacity-0 present/absent).

const target = { testId: "rail", description: '[data-testid="rail"]' };

test("describeStateMismatch returns empty when every provided check holds", () => {
  const observed = { classes: ["opacity-0", "flex"], attrs: { "data-testid": "rail" }, styleValue: "0" };
  assert.equal(describeStateMismatch(target, { hasClass: "opacity-0" }, observed), "");
  assert.equal(describeStateMismatch(target, { notHasClass: "opacity-100" }, observed), "");
  assert.equal(
    describeStateMismatch(target, { computedStyle: { property: "opacity", value: "0" } }, observed),
    ""
  );
  // All checks together still hold.
  assert.equal(
    describeStateMismatch(
      target,
      { hasClass: "opacity-0", notHasClass: "opacity-100", computedStyle: { property: "opacity", value: "0" } },
      observed
    ),
    ""
  );
});

test("describeStateMismatch reports the failing class check", () => {
  const observed = { classes: ["opacity-100"], attrs: {}, styleValue: null };
  assert.match(describeStateMismatch(target, { hasClass: "opacity-0" }, observed), /Expected class "opacity-0"/);
  assert.match(
    describeStateMismatch(target, { notHasClass: "opacity-100" }, observed),
    /"opacity-100" must be absent/
  );
});

test("describeStateMismatch checks attribute presence and value", () => {
  const observed = { classes: [], attrs: { "aria-expanded": "false" }, styleValue: null };
  assert.equal(describeStateMismatch(target, { attribute: { name: "aria-expanded" } }, observed), "");
  assert.match(
    describeStateMismatch(target, { attribute: { name: "aria-expanded", value: "true" } }, observed),
    /Expected attribute "aria-expanded"="true".*"false"/
  );
  assert.match(
    describeStateMismatch(target, { attribute: { name: "hidden" } }, observed),
    /Expected attribute "hidden".*absent/
  );
});

test("describeStateMismatch reports a computed-style mismatch", () => {
  const observed = { classes: [], attrs: {}, styleValue: "1" };
  assert.match(
    describeStateMismatch(target, { computedStyle: { property: "opacity", value: "0" } }, observed),
    /Expected computed opacity="0".*"1"/
  );
});
