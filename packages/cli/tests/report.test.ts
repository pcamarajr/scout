import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScoutConfig } from "../src/config.js";
import { buildReport, renderRunReport, renderSummary, scenarioStatus } from "../src/report.js";
import type { RunResult, Scenario, Step } from "../src/types.js";

const config: ScoutConfig = { baseUrl: "http://x", model: "m", headless: true, maxTurns: 40, profiles: {} };

const scn = (over: Partial<Scenario>): Scenario => ({
  slug: "f/s",
  name: "s",
  scenario: "...",
  feature: "f",
  file: ".scout/specs/f.scout.md",
  ...over,
});

const run = (slug: string, viewport: string, verdict: RunResult["verdict"], startedAt: string): RunResult => ({
  slug,
  viewport,
  mode: "ai",
  verdict,
  reason: "",
  runDir: "",
  startedAt,
  durationMs: 1,
  screenshots: [],
});

test("buildReport derives status/lastRun from the latest runs, one row per (scenario × viewport)", () => {
  const scenarios = [
    scn({ slug: "a/x", name: "X", feature: "A", profile: "anon" }), // default viewport (mobile)
    scn({ slug: "b/y", name: "Y", feature: "B", viewports: ["mobile", "desktop"] }), // fans out
    scn({ slug: "c/z", name: "Z", feature: "C" }),
  ];
  const latest = new Map<string, RunResult>([
    ["a/x@mobile", run("a/x", "mobile", "verified", "2026-06-10T12:00:00.000Z")],
    ["b/y@mobile", run("b/y", "mobile", "verified", "2026-06-10T13:00:00.000Z")],
    ["b/y@desktop", run("b/y", "desktop", "failed", "2026-06-10T13:30:00.000Z")],
    // c/z has no run → pending
  ]);

  const report = buildReport(scenarios, latest, config);

  // a/x@mobile + b/y@mobile + b/y@desktop + c/z@mobile = 4 units
  assert.deepEqual(report.summary, { total: 4, verified: 2, failed: 1, partial: 0, blocked: 0, pending: 1 });
  assert.deepEqual(report.scenarios[0], {
    slug: "a/x",
    name: "X",
    feature: "A",
    profile: "anon",
    viewport: "mobile",
    status: "verified",
    lastRun: "2026-06-10T12:00:00.000Z",
  });
  assert.equal(report.scenarios[1].viewport, "mobile");
  assert.equal(report.scenarios[1].status, "verified");
  assert.equal(report.scenarios[2].viewport, "desktop");
  assert.equal(report.scenarios[2].status, "failed");
  // no run → pending, optionals become explicit nulls (stable JSON shape)
  assert.equal(report.scenarios[3].status, "pending");
  assert.equal(report.scenarios[3].profile, null);
  assert.equal(report.scenarios[3].lastRun, null);
});

test("buildReport on an empty suite", () => {
  const report = buildReport([], new Map(), config);
  assert.deepEqual(report.summary, { total: 0, verified: 0, failed: 0, partial: 0, blocked: 0, pending: 0 });
  assert.deepEqual(report.scenarios, []);
});

test("scenarioStatus (deprecated) returns the most recent verdict across viewports", () => {
  const latest = new Map<string, RunResult>([
    ["a/x@mobile", run("a/x", "mobile", "verified", "2026-06-10T12:00:00.000Z")],
    ["a/x@desktop", run("a/x", "desktop", "failed", "2026-06-10T14:00:00.000Z")],
  ]);
  assert.equal(scenarioStatus("a/x", latest), "failed");
  assert.equal(scenarioStatus("never/ran", latest), "pending");
});

test("scenarioStatus (deprecated) still accepts pre-0.11 maps keyed by plain slug", () => {
  const latest = new Map<string, RunResult>([["a/x", run("a/x", "mobile", "verified", "2026-06-10T12:00:00.000Z")]]);
  assert.equal(scenarioStatus("a/x", latest), "verified");
});

test("renderRunReport surfaces fragile selectors and marks the offending step", () => {
  const scenario = scn({ name: "Checkout" });
  const steps: Step[] = [
    { kind: "click", target: { testId: "buy", description: '[data-testid="buy"]' } },
    { kind: "click", target: { css: "main > a:nth-of-type(2)", description: "main > a:nth-of-type(2)", fragile: true } },
  ];
  const result: RunResult = {
    ...run("f/s", "mobile", "verified", "2026-07-01T00:00:00.000Z"),
    fragileSteps: [{ step: 2, description: "click main > a:nth-of-type(2)" }],
  };
  const md = renderRunReport(result, scenario, steps);
  assert.match(md, /## ⚠️ Fragile selectors/);
  assert.match(md, /step 2 .* positional selector/);
  assert.match(md, /2\. click main > a:nth-of-type\(2\) ⚠️ fragile/);
});

test("renderRunReport lists fallback selectors that rescued a replay", () => {
  const scenario = scn({ name: "Nav" });
  const result: RunResult = {
    ...run("f/s", "mobile", "verified", "2026-07-01T00:00:00.000Z"),
    usedFallbacks: ['step 3: testid "go" → fallback css #real'],
  };
  const md = renderRunReport(result, scenario, []);
  assert.match(md, /## Fallback selectors used/);
  assert.match(md, /step 3: testid "go" → fallback css #real/);
});

test("renderRunReport omits the new sections when nothing is fragile and no fallback ran", () => {
  const md = renderRunReport(
    run("f/s", "mobile", "verified", "2026-07-01T00:00:00.000Z"),
    scn({ name: "Clean" }),
    [{ kind: "click", target: { testId: "ok", description: "ok" } }]
  );
  assert.doesNotMatch(md, /Fragile selectors/);
  assert.doesNotMatch(md, /Fallback selectors used/);
});

test("buildReport and renderSummary keep working without config (pre-0.11 two-argument calls)", () => {
  const scenarios = [scn({ slug: "a/x", name: "X", feature: "A" })];
  const latest = new Map<string, RunResult>([
    ["a/x@mobile", run("a/x", "mobile", "verified", "2026-06-10T12:00:00.000Z")],
  ]);

  const report = buildReport(scenarios, latest);
  assert.equal(report.summary.verified, 1);
  assert.equal(report.scenarios[0].viewport, "mobile"); // built-in default

  assert.match(renderSummary(scenarios, latest), /1\/1 verified/);
});
