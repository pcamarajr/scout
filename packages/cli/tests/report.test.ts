import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport } from "../src/report.js";
import type { RunResult, Scenario } from "../src/types.js";

const scn = (over: Partial<Scenario>): Scenario => ({
  slug: "f/s",
  name: "s",
  scenario: "...",
  feature: "f",
  file: ".scout/specs/f.scout.md",
  ...over,
});

const run = (slug: string, verdict: RunResult["verdict"], startedAt: string): RunResult => ({
  slug,
  mode: "ai",
  verdict,
  reason: "",
  runDir: "",
  startedAt,
  durationMs: 1,
  screenshots: [],
});

test("buildReport derives status/lastRun from the latest runs (specs never store it)", () => {
  const scenarios = [
    scn({ slug: "a/x", name: "X", feature: "A", profile: "anon" }),
    scn({ slug: "b/y", name: "Y", feature: "B" }),
    scn({ slug: "c/z", name: "Z", feature: "C" }),
  ];
  const latest = new Map<string, RunResult>([
    ["a/x", run("a/x", "verified", "2026-06-10T12:00:00.000Z")],
    ["b/y", run("b/y", "failed", "2026-06-10T13:00:00.000Z")],
    // c/z has no run → pending
  ]);

  const report = buildReport(scenarios, latest);

  assert.deepEqual(report.summary, { total: 3, verified: 1, failed: 1, partial: 0, blocked: 0, pending: 1 });
  assert.deepEqual(report.scenarios[0], {
    slug: "a/x",
    name: "X",
    feature: "A",
    profile: "anon",
    status: "verified",
    lastRun: "2026-06-10T12:00:00.000Z",
  });
  assert.equal(report.scenarios[1].status, "failed");
  // no run → pending, optionals become explicit nulls (stable JSON shape)
  assert.equal(report.scenarios[2].status, "pending");
  assert.equal(report.scenarios[2].profile, null);
  assert.equal(report.scenarios[2].lastRun, null);
});

test("buildReport on an empty suite", () => {
  const report = buildReport([], new Map());
  assert.deepEqual(report.summary, { total: 0, verified: 0, failed: 0, partial: 0, blocked: 0, pending: 0 });
  assert.deepEqual(report.scenarios, []);
});
