import assert from "node:assert/strict";
import { test } from "node:test";
import { pruneSteps } from "../src/engine.js";
import type { Step, Target } from "../src/types.js";

const field = (name: string): Target => ({ role: "textbox", name, description: `field ${name}` });
const button = (name: string): Target => ({ role: "button", name, description: `button ${name}` });

test("dedupes consecutive fills on the same target, keeping the last", () => {
  const steps: Step[] = [
    { kind: "fill", target: field("Password"), value: "$ENV:PASS_OLD" },
    { kind: "fill", target: field("Password"), value: "$ENV:PASS" },
  ];
  assert.deepEqual(pruneSteps(steps), [{ kind: "fill", target: field("Password"), value: "$ENV:PASS" }]);
});

test("dedupes near-consecutive fills when only inert steps sit in between", () => {
  const steps: Step[] = [
    { kind: "fill", target: field("Password"), value: "abc" },
    { kind: "screenshot", label: "form" },
    { kind: "assertVisible", text: "Sign in" },
    { kind: "fill", target: field("Email"), value: "x@y.com" },
    { kind: "fill", target: field("Password"), value: "abc" },
  ];
  const pruned = pruneSteps(steps);
  assert.equal(pruned.length, 4);
  assert.equal(pruned.filter((s) => s.kind === "fill" && s.target.name === "Password").length, 1);
});

test("does NOT dedupe fills separated by a click (value may have been consumed)", () => {
  const steps: Step[] = [
    { kind: "fill", target: field("Password"), value: "abc" },
    { kind: "click", target: button("Sign in") },
    { kind: "fill", target: field("Password"), value: "abc" },
  ];
  assert.deepEqual(pruneSteps(steps), steps);
});

test("does NOT dedupe fills separated by press/navigate", () => {
  const byPress: Step[] = [
    { kind: "fill", target: field("Search"), value: "a" },
    { kind: "press", key: "Enter" },
    { kind: "fill", target: field("Search"), value: "ab" },
  ];
  assert.deepEqual(pruneSteps(byPress), byPress);

  const byNavigate: Step[] = [
    { kind: "fill", target: field("Search"), value: "a" },
    { kind: "navigate", url: "/results" },
    { kind: "fill", target: field("Search"), value: "ab" },
  ];
  assert.deepEqual(pruneSteps(byNavigate), byNavigate);
});

test("never dedupes clicks, even consecutive on the same target", () => {
  const steps: Step[] = [
    { kind: "click", target: button("Next") },
    { kind: "click", target: button("Next") },
  ];
  assert.deepEqual(pruneSteps(steps), steps);
});

test("dedupes consecutive selects on the same target", () => {
  const sel: Target = { role: "combobox", name: "Language", description: "select Language" };
  const steps: Step[] = [
    { kind: "select", target: sel, value: "en-US" },
    { kind: "select", target: sel, value: "pt-BR" },
  ];
  assert.deepEqual(pruneSteps(steps), [{ kind: "select", target: sel, value: "pt-BR" }]);
});

test("returns the same array when nothing is pruned", () => {
  const steps: Step[] = [
    { kind: "navigate", url: "/login" },
    { kind: "fill", target: field("Email"), value: "x@y.com" },
    { kind: "fill", target: field("Password"), value: "$ENV:PASS" },
    { kind: "click", target: button("Sign in") },
    { kind: "assertUrl", pattern: "/home" },
  ];
  assert.equal(pruneSteps(steps), steps);
});

test("switchTab acts as a barrier: fills around it are not deduped", () => {
  const steps: Step[] = [
    { kind: "fill", target: field("Search"), value: "a" },
    { kind: "switchTab" },
    { kind: "fill", target: field("Search"), value: "a" },
  ];
  // The two fills target the "same" field but live on different tabs — keep both.
  assert.deepEqual(pruneSteps(steps), steps);
});
