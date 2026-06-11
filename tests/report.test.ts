import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport } from "../src/report.js";
import type { Scenario } from "../src/types.js";

const scenario = (over: Partial<Scenario>): Scenario => ({
  id: 1,
  slug: "s",
  name: "s",
  scenario: "...",
  status: "pending",
  createdAt: "2026-06-10T00:00:00.000Z",
  ...over,
});

test("buildReport emits per-scenario rows and a status summary", () => {
  const report = buildReport([
    scenario({ id: 1, slug: "a", name: "A", status: "verified", profile: "anon", lastRun: "2026-06-10T12:00:00.000Z" }),
    scenario({ id: 2, slug: "b", name: "B", status: "failed" }),
    scenario({ id: 3, slug: "c", name: "C", status: "pending" }),
  ]);

  assert.deepEqual(report.summary, { total: 3, verified: 1, failed: 1, partial: 0, blocked: 0, pending: 1 });
  assert.deepEqual(report.scenarios[0], {
    id: 1,
    slug: "a",
    name: "A",
    profile: "anon",
    status: "verified",
    lastRun: "2026-06-10T12:00:00.000Z",
  });
  // omitted optionals become explicit nulls (stable JSON shape for consumers)
  assert.equal(report.scenarios[1].profile, null);
  assert.equal(report.scenarios[1].lastRun, null);
});

test("buildReport on an empty suite", () => {
  const report = buildReport([]);
  assert.deepEqual(report.summary, { total: 0, verified: 0, failed: 0, partial: 0, blocked: 0, pending: 0 });
  assert.deepEqual(report.scenarios, []);
});
