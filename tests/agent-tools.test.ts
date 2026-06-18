import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScoutConfig } from "../src/config.js";
import { createScoutTools, type ScoutTool } from "../src/runner/agent-tools.js";
import type { BrowserSession } from "../src/runner/browser.js";
import type { Step, Target, Verdict } from "../src/types.js";

/**
 * In-memory BrowserSession stub: records the calls the tools make and returns
 * canned values, so the engine-neutral tool layer can be exercised with no real
 * browser. Only the methods the tools touch are implemented.
 */
function fakeSession(overrides: Partial<Record<string, unknown>> = {}): {
  session: BrowserSession;
  calls: string[];
} {
  const calls: string[] = [];
  const target = (description: string): Target => ({ role: "button", name: description, description });
  const session = {
    snapshot: async () => ({ url: "http://localhost:3000/x", title: "X", text: "hello", elements: [] }),
    formatSnapshot: () => "URL: http://localhost:3000/x",
    navigate: async (url: string) => void calls.push(`navigate:${url}`),
    click: async (ref: number) => {
      calls.push(`click:${ref}`);
      return target("Login");
    },
    fill: async (ref: number, value: string) => {
      calls.push(`fill:${ref}:${value}`);
      return target("Email");
    },
    select: async (ref: number, value: string) => {
      calls.push(`select:${ref}:${value}`);
      return target("Plan");
    },
    press: async (key: string) => void calls.push(`press:${key}`),
    waitForText: async (text: string) => void calls.push(`waitForText:${text}`),
    waitForUrl: async (p: string) => void calls.push(`waitForUrl:${p}`),
    assertVisible: async (text: string) => void calls.push(`assertVisible:${text}`),
    assertNotVisible: async (text: string) => void calls.push(`assertNotVisible:${text}`),
    assertUrl: async (p: string) => void calls.push(`assertUrl:${p}`),
    screenshot: async (label: string) => {
      calls.push(`screenshot:${label}`);
      return `/runs/${label}.png`;
    },
    ...overrides,
  } as unknown as BrowserSession;
  return { session, calls };
}

const config = { baseUrl: "http://localhost:3000", profiles: {}, maxTurns: 40 } as unknown as ScoutConfig;

function harness(sessionOverrides?: Partial<Record<string, unknown>>) {
  const steps: Step[] = [];
  let verdict: { verdict: Verdict; reason: string } | undefined;
  const { session, calls } = fakeSession(sessionOverrides);
  const tools = createScoutTools({
    session,
    config,
    record: (s) => steps.push(s),
    setVerdict: (v) => (verdict = v),
  });
  const byName = (name: string): ScoutTool => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  return { tools, byName, steps, calls, getVerdict: () => verdict };
}

test("exposes the 9 browser tools plus scout_verdict", () => {
  const { tools } = harness();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "browser_assert",
      "browser_click",
      "browser_fill",
      "browser_navigate",
      "browser_press",
      "browser_screenshot",
      "browser_select",
      "browser_snapshot",
      "browser_wait_for",
      "scout_verdict",
    ]
  );
});

test("browser_navigate records a relativized navigate step", async () => {
  const { byName, steps, calls } = harness();
  const r = await byName("browser_navigate").handler({ url: "http://localhost:3000/login" });
  assert.equal(r.isError, undefined);
  assert.deepEqual(steps, [{ kind: "navigate", url: "/login" }]);
  assert.deepEqual(calls, ["navigate:http://localhost:3000/login"]);
});

test("browser_click records a click step with the resolved target", async () => {
  const { byName, steps } = harness();
  await byName("browser_click").handler({ ref: 3 });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, "click");
});

test("browser_fill records the literal placeholder value (not the resolved secret)", async () => {
  const { byName, steps } = harness();
  process.env.SCOUT_TEST_SECRET = "hunter2";
  try {
    await byName("browser_fill").handler({ ref: 2, value: "$ENV:SCOUT_TEST_SECRET" });
  } finally {
    delete process.env.SCOUT_TEST_SECRET;
  }
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, "fill");
  // The recorded step keeps the placeholder so secrets never land in the script.
  assert.equal((steps[0] as { value: string }).value, "$ENV:SCOUT_TEST_SECRET");
});

test("browser_assert records one step per provided expectation", async () => {
  const { byName, steps } = harness();
  await byName("browser_assert").handler({ visibleText: "Welcome", urlContains: "/home" });
  assert.deepEqual(steps, [
    { kind: "assertVisible", text: "Welcome" },
    { kind: "assertUrl", pattern: "/home" },
  ]);
});

test("scout_verdict feeds the verdict sink and records no step", async () => {
  const { byName, steps, getVerdict } = harness();
  const r = await byName("scout_verdict").handler({ verdict: "verified", reason: "all good" });
  assert.equal(r.isError, undefined);
  assert.deepEqual(getVerdict(), { verdict: "verified", reason: "all good" });
  assert.equal(steps.length, 0);
});

test("a handler that throws is normalized to an isError result and records nothing", async () => {
  const { byName, steps } = harness({
    navigate: async () => {
      throw new Error("net down");
    },
  });
  const r = await byName("browser_navigate").handler({ url: "/x" });
  assert.equal(r.isError, true);
  assert.match(r.text, /ERRO: net down/);
  assert.equal(steps.length, 0);
});
