import assert from "node:assert/strict";
import { test } from "node:test";
import { runAiWithRetry } from "../src/engine.js";
import { describeNoVerdict, relativizeUrl } from "../src/runner/ai-runner.js";

// --- relativizeUrl: recorded scripts must survive --base-url pointing elsewhere ---

test("relativizeUrl strips the baseUrl prefix", () => {
  assert.equal(relativizeUrl("http://localhost:3000/serie/abc", "http://localhost:3000"), "/serie/abc");
});

test("relativizeUrl maps the bare baseUrl (with or without slash) to /", () => {
  assert.equal(relativizeUrl("http://localhost:3000", "http://localhost:3000"), "/");
  assert.equal(relativizeUrl("http://localhost:3000/", "http://localhost:3000"), "/");
  assert.equal(relativizeUrl("http://localhost:3000", "http://localhost:3000/"), "/");
});

test("relativizeUrl keeps query/hash-only suffixes relative", () => {
  assert.equal(relativizeUrl("http://localhost:3000?tab=eps", "http://localhost:3000"), "?tab=eps");
  assert.equal(relativizeUrl("http://localhost:3000#player", "http://localhost:3000"), "#player");
});

test("relativizeUrl does NOT strip prefix-lookalike hosts", () => {
  assert.equal(
    relativizeUrl("http://localhost:30001/serie/abc", "http://localhost:3000"),
    "http://localhost:30001/serie/abc"
  );
});

test("relativizeUrl leaves external and already-relative URLs untouched", () => {
  assert.equal(relativizeUrl("https://other.app/x", "http://localhost:3000"), "https://other.app/x");
  assert.equal(relativizeUrl("/login", "http://localhost:3000"), "/login");
});

// --- describeNoVerdict: silent agent deaths must carry their cause ---

test("describeNoVerdict names the turn budget on error_max_turns", () => {
  const msg = describeNoVerdict({ subtype: "error_max_turns", numTurns: 40 }, 40);
  assert.match(msg, /40-turn/);
  assert.match(msg, /scout_verdict/);
});

test("describeNoVerdict surfaces SDK execution errors", () => {
  const msg = describeNoVerdict({ subtype: "error_during_execution", errors: ["boom"] }, 40);
  assert.match(msg, /boom/);
});

test("describeNoVerdict distinguishes a normally-ended-but-mute agent", () => {
  assert.match(describeNoVerdict({ subtype: "success" }, 40), /ended normally/);
});

test("describeNoVerdict handles a query that produced no result message", () => {
  assert.match(describeNoVerdict(undefined, 40), /without emitting a result/);
});

// --- runAiWithRetry: retry runner failures once, never retry real verdicts ---

test("retries once when the first attempt is a runner failure", async () => {
  const calls: number[] = [];
  const { outcome, attempts } = await runAiWithRetry(async (n) => {
    calls.push(n);
    return n === 1 ? { runnerFailure: "max turns" } : {};
  });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(attempts, 2);
  assert.equal(outcome.runnerFailure, undefined);
});

test("does not retry when the first attempt produced a verdict", async () => {
  let calls = 0;
  const { attempts } = await runAiWithRetry(async () => {
    calls++;
    return { verdict: "failed" } as { runnerFailure?: string };
  });
  assert.equal(calls, 1);
  assert.equal(attempts, 1);
});

test("gives up after maxAttempts and reports the persistent runner failure", async () => {
  let calls = 0;
  const { outcome, attempts } = await runAiWithRetry(async () => {
    calls++;
    return { runnerFailure: "still dead" };
  }, 2);
  assert.equal(calls, 2);
  assert.equal(attempts, 2);
  assert.equal(outcome.runnerFailure, "still dead");
});
