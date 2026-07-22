import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assembleTarget,
  buildLadderCandidates,
  collectFragileSteps,
  describeTargetStrategy,
  fragileWarning,
  idSelector,
  isStableId,
  runWithFallback,
  type LadderCandidate,
  type LadderInfo,
} from "../src/runner/selector-ladder.js";
import type { Step, Target } from "../src/types.js";

// ---- isStableId: the auto-generated-id rejection heuristic ----

test("isStableId accepts hand-authored ids", () => {
  for (const id of ["login-form", "email", "submit_btn", "nav", "a-b-c"]) {
    assert.equal(isStableId(id), true, `expected "${id}" to be stable`);
  }
});

test("isStableId rejects framework-generated ids", () => {
  for (const id of [
    "radix-:r1:", // Radix
    ":r0:", // React useId
    ":R2ab:", // React useId (uppercase form)
    "react-select-3-input", // react-*
    "headlessui-menu-button-1",
    "mui-42",
    "field-1234", // 3+ digit run
    "tooltip-9871",
  ]) {
    assert.equal(isStableId(id), false, `expected "${id}" to be rejected`);
  }
});

test("isStableId rejects empty/whitespace/undefined", () => {
  assert.equal(isStableId(undefined), false);
  assert.equal(isStableId(""), false);
  assert.equal(isStableId("   "), false);
});

test("idSelector emits an attribute selector and escapes quotes/backslashes", () => {
  assert.equal(idSelector("email"), '[id="email"]');
  assert.equal(idSelector('a"b'), '[id="a\\"b"]');
  assert.equal(idSelector("a\\b"), '[id="a\\\\b"]');
});

// ---- ladder ordering: testid > id > role+name > text > css ----

const fullInfo: LadderInfo = {
  testId: "submit",
  id: "login-btn",
  role: "button",
  name: "Log in",
  text: "Log in",
  css: "form > button:nth-of-type(1)",
};

test("buildLadderCandidates orders testid > id > role+name > text > css", () => {
  const strategies = buildLadderCandidates(fullInfo).map((c) => c.strategy);
  assert.deepEqual(strategies, ["testid", "id", "role", "text", "css"]);
});

test("buildLadderCandidates skips rungs that lack their signal, css always last", () => {
  const info: LadderInfo = { role: "link", name: "Home", css: "a:nth-of-type(2)" };
  const strategies = buildLadderCandidates(info).map((c) => c.strategy);
  assert.deepEqual(strategies, ["role", "css"]);
});

test("buildLadderCandidates rejects an auto-generated id (drops the id rung)", () => {
  const info: LadderInfo = { id: "radix-:r3:", role: "button", name: "X", css: "button" };
  const strategies = buildLadderCandidates(info).map((c) => c.strategy);
  assert.ok(!strategies.includes("id"), "auto id must not become a rung");
  assert.deepEqual(strategies, ["role", "css"]);
});

test("buildLadderCandidates borrows an ancestor testid only for clicks", () => {
  const info: LadderInfo = { ancestorTestId: "card", css: "div > span" };
  assert.equal(
    buildLadderCandidates(info, { allowAncestorTestId: true })[0].strategy,
    "testid"
  );
  assert.equal(buildLadderCandidates(info, { allowAncestorTestId: false })[0].strategy, "css");
});

test("buildLadderCandidates prefers the element's own testid over an ancestor's", () => {
  const info: LadderInfo = { testId: "own", ancestorTestId: "card", css: "div" };
  const testId = buildLadderCandidates(info, { allowAncestorTestId: true })[0].target.testId;
  assert.equal(testId, "own");
});

test("an ancestor testid ranks below the element's OWN role/name, above positional css", () => {
  // The element has a unique role+name AND sits inside a testid'd wrapper: we
  // must act on the element itself (role+name), not the container — the ancestor
  // testid is only a rescue just above the positional path.
  const info: LadderInfo = {
    role: "link",
    name: "Open card",
    ancestorTestId: "card",
    css: "div > a",
  };
  const strategies = buildLadderCandidates(info, { allowAncestorTestId: true }).map((c) => c.strategy);
  assert.deepEqual(strategies, ["role", "testid", "css"]);
  const ancestorIdx = strategies.indexOf("testid");
  assert.ok(ancestorIdx > strategies.indexOf("role"), "ancestor testid must rank below own role+name");
  assert.ok(ancestorIdx < strategies.indexOf("css"), "ancestor testid must rank above positional css");
});

test("buildLadderCandidates honors a custom testid attribute in the description", () => {
  const info: LadderInfo = { testId: "x", css: "div" };
  const [candidate] = buildLadderCandidates(info, { testIdAttr: "data-qa" });
  assert.equal(candidate.target.description, '[data-qa="x"]');
});

// ---- assembleTarget: primary + fallbacks + fragile ----

test("assembleTarget picks the first unique rung as primary, rest as ordered fallbacks", () => {
  const candidates = buildLadderCandidates(fullInfo);
  // testid + role uniquely matched; id + text did not.
  const unique = candidates.filter((c) => c.strategy === "testid" || c.strategy === "role");
  const target = assembleTarget(candidates, unique);
  assert.equal(target.testId, "submit");
  assert.equal(target.fragile, undefined);
  assert.equal(target.fallbacks?.length, 1);
  assert.equal(target.fallbacks?.[0].role, "button");
});

test("assembleTarget flags fragile when the positional css rung is the primary", () => {
  const candidates = buildLadderCandidates(fullInfo);
  const unique = candidates.filter((c) => c.strategy === "css");
  const target = assembleTarget(candidates, unique);
  assert.equal(target.fragile, true);
  assert.equal(target.css, fullInfo.css);
  assert.equal(target.fallbacks, undefined);
});

test("assembleTarget falls back to css (fragile) when NOTHING uniquely matched", () => {
  const candidates = buildLadderCandidates(fullInfo);
  const target = assembleTarget(candidates, []);
  assert.equal(target.fragile, true);
  assert.equal(target.css, fullInfo.css);
});

test("assembleTarget keeps the css fallback alongside a stable primary", () => {
  const candidates = buildLadderCandidates(fullInfo);
  const unique = candidates.filter((c) => c.strategy === "testid" || c.strategy === "css");
  const target = assembleTarget(candidates, unique);
  assert.equal(target.testId, "submit");
  assert.equal(target.fragile, undefined);
  assert.equal(target.fallbacks?.[0].css, fullInfo.css);
});

// ---- describeTargetStrategy ----

test("describeTargetStrategy labels each strategy", () => {
  assert.equal(describeTargetStrategy({ testId: "x", description: "" }), 'testid "x"');
  assert.equal(
    describeTargetStrategy({ role: "button", name: "Go", description: "" }),
    'role button "Go"'
  );
  assert.equal(describeTargetStrategy({ text: "Hi", description: "" }), 'text "Hi"');
  assert.equal(describeTargetStrategy({ css: "a > b", description: "" }), "css a > b");
});

// ---- runWithFallback: deterministic replay retry ----

/** A fake "locator" is just its target; `act` decides success by inspecting it. */
const locate = (t: Target): Target => t;

test("runWithFallback uses the primary and never touches fallbacks when it succeeds", async () => {
  const seen: string[] = [];
  const target: Target = {
    testId: "primary",
    description: "primary",
    fallbacks: [{ css: "fb", description: "fb" }],
  };
  let used: string | undefined;
  await runWithFallback(
    target,
    locate,
    async (loc) => {
      seen.push(loc.description);
    },
    (note) => (used = note)
  );
  assert.deepEqual(seen, ["primary"]);
  assert.equal(used, undefined);
});

test("runWithFallback tries fallbacks in order when the primary fails, and logs the one that resolved", async () => {
  const target: Target = {
    testId: "primary",
    description: "primary",
    fallbacks: [
      { role: "button", name: "Nope", description: "fb1" },
      { css: "#works", description: "fb2" },
    ],
  };
  const attempts: string[] = [];
  let note: string | undefined;
  await runWithFallback(
    target,
    locate,
    async (loc) => {
      attempts.push(loc.description);
      // primary and fb1 fail; fb2 (css #works) resolves.
      if (loc.description !== "fb2") throw new Error(`no match: ${loc.description}`);
    },
    (n) => (note = n)
  );
  assert.deepEqual(attempts, ["primary", "fb1", "fb2"]);
  assert.match(note ?? "", /testid "primary" → fallback css #works/);
});

test("runWithFallback rethrows the PRIMARY error when every candidate fails", async () => {
  const target: Target = {
    testId: "primary",
    description: "primary",
    fallbacks: [{ css: "fb", description: "fb" }],
  };
  await assert.rejects(
    runWithFallback(target, locate, async (loc) => {
      throw new Error(`fail:${loc.description}`);
    }),
    /fail:primary/
  );
});

test("runWithFallback with no fallbacks behaves like a plain action (error propagates)", async () => {
  const target: Target = { css: "x", description: "x" };
  await assert.rejects(
    runWithFallback(target, locate, async () => {
      throw new Error("boom");
    }),
    /boom/
  );
});

// ---- fragility surfacing ----

test("fragileWarning names the step and prescribes a fix", () => {
  const msg = fragileWarning({ step: 4, description: "click a > b" });
  assert.match(msg, /step 4/);
  assert.match(msg, /positional selector/);
  assert.match(msg, /data-testid/);
});

test("collectFragileSteps flags only interaction steps on a positional selector", () => {
  const steps: Step[] = [
    { kind: "navigate", url: "/" },
    { kind: "click", target: { testId: "ok", description: "ok" } }, // stable → not flagged
    { kind: "click", target: { css: "a > b", description: "a > b", fragile: true } }, // flagged
    { kind: "fill", target: { css: "form > input", description: "input", fragile: true }, value: "x" },
    { kind: "assertVisible", text: "Done" },
  ];
  const fragile = collectFragileSteps(steps);
  assert.deepEqual(
    fragile.map((f) => f.step),
    [3, 4]
  );
  assert.match(fragile[0].description, /click/);
});

test("collectFragileSteps returns empty when every step has a stable handle", () => {
  const steps: Step[] = [
    { kind: "click", target: { testId: "a", description: "a" } },
    { kind: "fill", target: { role: "textbox", name: "Email", description: "Email" }, value: "x" },
  ];
  assert.deepEqual(collectFragileSteps(steps), []);
});
