import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findConsoleErrors,
  globToRegex,
  matchNetwork,
  matchStatus,
  type CapturedRequest,
} from "../src/runner/network-match.js";

const req = (
  method: string,
  url: string,
  status: number,
  body = ""
): CapturedRequest => ({ method, url, status, getBody: async () => body });

test("globToRegex: * stays within a path segment, ** crosses segments", () => {
  assert.ok(globToRegex("**/api/checkout").test("https://app.test/api/checkout"));
  assert.ok(globToRegex("**/api/checkout").test("https://app.test/v2/api/checkout?x=1"));
  // single * does not cross a slash (literal segment anchors both sides)
  assert.ok(globToRegex("**/api/*/items").test("https://app.test/api/v2/items"));
  assert.ok(!globToRegex("**/api/*/items").test("https://app.test/api/v2/sub/items"));
  // ** does cross slashes
  assert.ok(globToRegex("**/api/**/items").test("https://app.test/api/v2/sub/items"));
});

test("globToRegex: ? in a query string is literal, not a wildcard", () => {
  const re = globToRegex("**/search?q");
  assert.ok(re.test("https://app.test/search?q"));
  assert.ok(!re.test("https://app.test/searchXq"));
});

test("matchStatus: exact code and class", () => {
  assert.ok(matchStatus(200, 200));
  assert.ok(!matchStatus(200, 201));
  assert.ok(matchStatus("2xx", 204));
  assert.ok(matchStatus("4xx", 404));
  assert.ok(!matchStatus("2xx", 500));
  assert.ok(matchStatus(undefined, 500)); // omitted = any
});

test("matchNetwork: matches by method + url glob + status", async () => {
  const entries = [
    req("GET", "https://app.test/api/me", 200),
    req("POST", "https://app.test/api/checkout", 201),
  ];
  assert.deepEqual(await matchNetwork(entries, { method: "POST", urlGlob: "**/api/checkout", status: "2xx" }), {
    ok: true,
  });
});

test("matchNetwork: reports a miss when nothing matches", async () => {
  const entries = [req("GET", "https://app.test/api/me", 200)];
  const r = await matchNetwork(entries, { method: "POST", urlGlob: "**/api/checkout" });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /No observed request/);
});

test("matchNetwork: responseIncludes requires all substrings in one response", async () => {
  const entries = [
    req("POST", "https://app.test/api/checkout", 200, '{"orderId":"abc","total":99.9}'),
  ];
  assert.equal((await matchNetwork(entries, { urlGlob: "**/checkout", responseIncludes: ["orderId"] })).ok, true);
  assert.equal(
    (await matchNetwork(entries, { urlGlob: "**/checkout", responseIncludes: ["orderId", "missing"] })).ok,
    false
  );
});

test("matchNetwork: a non-matching candidate body does not satisfy responseIncludes", async () => {
  const entries = [
    req("POST", "https://app.test/api/checkout", 200, '{"error":"nope"}'),
    req("POST", "https://app.test/api/checkout", 200, '{"orderId":"abc"}'),
  ];
  // second candidate has the substring → ok
  assert.equal((await matchNetwork(entries, { urlGlob: "**/checkout", responseIncludes: ["orderId"] })).ok, true);
});

test("findConsoleErrors: keeps console errors, drops warnings and ignored substrings", () => {
  const messages = [
    { type: "warning", text: "deprecated" },
    { type: "error", text: "Failed to load resource: favicon.ico" },
    { type: "error", text: "TypeError: x is not a function" },
  ];
  assert.equal(findConsoleErrors(messages).length, 2);
  assert.equal(findConsoleErrors(messages, ["favicon"]).length, 1);
});
