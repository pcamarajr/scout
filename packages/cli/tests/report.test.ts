import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScoutConfig } from "../src/config.js";
import { buildReport, renderSummary, scenarioStatus } from "../src/report.js";
import type { RunResult, Scenario } from "../src/types.js";

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
