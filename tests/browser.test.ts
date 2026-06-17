import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEnvValue } from "../src/runner/browser.js";

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

test("resolveEnvValue throws when the referenced env var is undefined", () => {
  delete process.env.SCOUT_TEST_MISSING;
  assert.throws(() => resolveEnvValue("/x?t=$ENV:SCOUT_TEST_MISSING"), /SCOUT_TEST_MISSING/);
});
