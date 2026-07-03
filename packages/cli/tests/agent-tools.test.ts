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
    wheel: async (dx: number, dy: number, x?: number, y?: number) =>
      void calls.push(`wheel:${dx}:${dy}:${x ?? "center"}:${y ?? "center"}`),
    drag: async (fx: number, fy: number, tx: number, ty: number) =>
      void calls.push(`drag:${fx}:${fy}:${tx}:${ty}`),
    waitForText: async (text: string, timeout?: number) =>
      void calls.push(`waitForText:${text}:${timeout ?? "default"}`),
    waitForUrl: async (p: string, timeout?: number) =>
      void calls.push(`waitForUrl:${p}:${timeout ?? "default"}`),
    assertVisible: async (text: string, opts?: { timeout?: number; oneShot?: boolean }) =>
      void calls.push(
        `assertVisible:${text}:${opts?.timeout ?? "default"}:${opts?.oneShot ? "one-shot" : "poll"}`
      ),
    assertNotVisible: async (text: string, timeout?: number) =>
      void calls.push(`assertNotVisible:${text}:${timeout ?? "default"}`),
    assertUrl: async (p: string, timeout?: number) =>
      void calls.push(`assertUrl:${p}:${timeout ?? "default"}`),
    assertNetwork: async (m: { urlGlob: string }) => void calls.push(`assertNetwork:${m.urlGlob}`),
    assertNoConsoleErrors: async (ignore?: string[]) =>
      void calls.push(`assertNoConsoleErrors:${(ignore ?? []).join(",")}`),
    assertConsoleMessage: async (includes: string[], type?: string) =>
      void calls.push(`assertConsoleMessage:${includes.join("+")}:${type ?? "any"}`),
    tabCount: () => 1,
    switchTab: async (urlGlob?: string) => void calls.push(`switchTab:${urlGlob ?? "newest"}`),
    page: { url: () => "http://localhost:3000/x" },
    formatLogs: () => "Network (0 requests total, last 0):\n  (none)",
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

test("exposes the browser tools plus scout_verdict", () => {
  const { tools } = harness();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "browser_assert",
      "browser_assert_console_message",
      "browser_assert_network",
      "browser_assert_no_console_errors",
      "browser_click",
      "browser_drag",
      "browser_fill",
      "browser_inspect_logs",
      "browser_navigate",
      "browser_press",
      "browser_screenshot",
      "browser_select",
      "browser_snapshot",
      "browser_switch_tab",
      "browser_wait_for",
      "browser_wheel",
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

test("browser_assert without timeout/oneShot records bare steps (backward compatible)", async () => {
  const { byName, steps, calls } = harness();
  await byName("browser_assert").handler({ visibleText: "Welcome" });
  // The recorded step carries NO timeout/oneShot keys, so existing scripts and
  // freshly recorded ones stay byte-identical to the previous format.
  assert.deepEqual(steps, [{ kind: "assertVisible", text: "Welcome" }]);
  assert.deepEqual(calls, ["assertVisible:Welcome:default:poll"]);
});

test("browser_assert forwards timeoutMs and oneShot and records them on the steps", async () => {
  const { byName, steps, calls } = harness();
  await byName("browser_assert").handler({
    visibleText: "Total",
    notVisibleText: "Loading",
    urlContains: "/done",
    timeoutMs: 1500,
    oneShot: true,
  });
  assert.deepEqual(steps, [
    { kind: "assertVisible", text: "Total", timeout: 1500, oneShot: true },
    { kind: "assertNotVisible", text: "Loading", timeout: 1500 },
    { kind: "assertUrl", pattern: "/done", timeout: 1500 },
  ]);
  assert.deepEqual(calls, [
    "assertVisible:Total:1500:one-shot",
    "assertNotVisible:Loading:1500",
    "assertUrl:/done:1500",
  ]);
});

test("browser_wait_for forwards timeoutMs and records it on the steps", async () => {
  const { byName, steps, calls } = harness();
  await byName("browser_wait_for").handler({ text: "Ready", urlContains: "/next", timeoutMs: 3000 });
  assert.deepEqual(steps, [
    { kind: "waitForText", text: "Ready", timeout: 3000 },
    { kind: "waitForUrl", pattern: "/next", timeout: 3000 },
  ]);
  assert.deepEqual(calls, ["waitForText:Ready:3000", "waitForUrl:/next:3000"]);

  // Without timeoutMs the steps stay bare and the session sees the default.
  steps.length = 0;
  calls.length = 0;
  await byName("browser_wait_for").handler({ text: "Ready" });
  assert.deepEqual(steps, [{ kind: "waitForText", text: "Ready" }]);
  assert.deepEqual(calls, ["waitForText:Ready:default"]);
});

test("browser_assert_network records a network assertion with only the provided fields", async () => {
  const { byName, steps, calls } = harness();
  await byName("browser_assert_network").handler({
    urlGlob: "**/api/checkout/**",
    method: "POST",
    status: "2xx",
    responseIncludes: ["orderId"],
  });
  assert.deepEqual(calls, ["assertNetwork:**/api/checkout/**"]);
  assert.deepEqual(steps, [
    {
      kind: "assertNetwork",
      urlGlob: "**/api/checkout/**",
      method: "POST",
      status: "2xx",
      responseIncludes: ["orderId"],
    },
  ]);
});

test("browser_assert_no_console_errors records a console assertion", async () => {
  const { byName, steps, calls } = harness();
  await byName("browser_assert_no_console_errors").handler({ ignore: ["favicon"] });
  assert.deepEqual(calls, ["assertNoConsoleErrors:favicon"]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, "assertNoConsoleErrors");
});

test("browser_inspect_logs is read-only — returns the dump and records nothing", async () => {
  const { byName, steps } = harness();
  const r = await byName("browser_inspect_logs").handler({});
  assert.equal(r.isError, undefined);
  assert.match(r.text, /Network/);
  assert.equal(steps.length, 0);
});

test("a failing network assertion is an isError result and records nothing", async () => {
  const { byName, steps } = harness({
    assertNetwork: async () => {
      throw new Error("No observed request matched POST **/api/x.");
    },
  });
  const r = await byName("browser_assert_network").handler({ urlGlob: "**/api/x", method: "POST" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No observed request/);
  assert.equal(steps.length, 0);
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
  assert.match(r.text, /ERROR: net down/);
  assert.equal(steps.length, 0);
});

test("browser_wheel dispatches the gesture and records a wheel step", async () => {
  const { byName, steps, calls } = harness();

  await byName("browser_wheel").handler({ deltaX: 0, deltaY: 400, x: 200, y: 300 });
  assert.deepEqual(steps, [{ kind: "wheel", deltaX: 0, deltaY: 400, x: 200, y: 300 }]);
  assert.deepEqual(calls, ["wheel:0:400:200:300"]);

  // No coordinates → the step omits x/y (replay recenters from the viewport).
  steps.length = 0;
  await byName("browser_wheel").handler({ deltaX: 0, deltaY: -120 });
  assert.deepEqual(steps, [{ kind: "wheel", deltaX: 0, deltaY: -120 }]);
  assert.ok(calls.includes("wheel:0:-120:center:center"));
});

test("browser_drag drags between points and records a drag step", async () => {
  const { byName, steps, calls } = harness();
  await byName("browser_drag").handler({ fromX: 195, fromY: 600, toX: 195, toY: 200 });
  assert.deepEqual(steps, [{ kind: "drag", fromX: 195, fromY: 600, toX: 195, toY: 200 }]);
  assert.deepEqual(calls, ["drag:195:600:195:200"]);
});

test("browser_switch_tab switches and records a switchTab step", async () => {
  const { byName, steps, calls } = harness();

  await byName("browser_switch_tab").handler({ urlGlob: "**/booking**" });
  assert.deepEqual(steps, [{ kind: "switchTab", urlGlob: "**/booking**" }]);
  assert.ok(calls.includes("switchTab:**/booking**"));

  // No glob → newest tab; the step omits urlGlob.
  steps.length = 0;
  await byName("browser_switch_tab").handler({});
  assert.deepEqual(steps, [{ kind: "switchTab" }]);
  assert.ok(calls.includes("switchTab:newest"));
});

test("browser_click hints when a click opens a new tab", async () => {
  let count = 1;
  const { byName } = harness({ tabCount: () => count });
  // Simulate the click opening a tab: count grows during the handler.
  const res = await byName("browser_click").handler({ ref: 1 });
  assert.doesNotMatch(res.text, /new tab/); // no growth → no hint

  const { byName: byName2 } = harness({
    tabCount: () => count++, // 1 before click, 2 after
  });
  const res2 = await byName2("browser_click").handler({ ref: 1 });
  assert.match(res2.text, /A new tab was opened/);
});

test("browser_assert_console_message records an assertConsoleMessage step", async () => {
  const { byName, steps, calls } = harness();

  await byName("browser_assert_console_message").handler({
    includes: ["DEBUG:[GAT]", "active"],
    type: "log",
  });
  assert.deepEqual(steps, [
    { kind: "assertConsoleMessage", includes: ["DEBUG:[GAT]", "active"], type: "log" },
  ]);
  assert.ok(calls.includes("assertConsoleMessage:DEBUG:[GAT]+active:log"));

  // No type → omitted from the recorded step.
  steps.length = 0;
  await byName("browser_assert_console_message").handler({ includes: ["DEBUG"] });
  assert.deepEqual(steps, [{ kind: "assertConsoleMessage", includes: ["DEBUG"] }]);
});

test("browser_assert_console_message rejects an empty substring (no false-pass)", async () => {
  const { byName } = harness();
  // Schema rejects [""] and [] at the tool boundary (parse throws synchronously).
  await assert.rejects(async () => byName("browser_assert_console_message").handler({ includes: [""] }));
  await assert.rejects(async () => byName("browser_assert_console_message").handler({ includes: [] }));
});
