import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStorageInitScript,
  demoCursorStub,
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
