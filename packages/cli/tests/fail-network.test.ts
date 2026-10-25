import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renderRunReport } from "../src/report.js";
import { guardUnexercisedFaults } from "../src/runner/ai-runner.js";
import { globToRegex, matchNetwork, type CapturedRequest } from "../src/runner/network-match.js";
import { collectFaultReports, describeStep, replaySteps } from "../src/runner/script-runner.js";
import { normalizeNetworkFault, parseSteps } from "../src/runner/step-schema.js";
import type { BrowserSession, FaultOutcome } from "../src/runner/browser.js";
import { parseSpec } from "../src/specs.js";
import { Store } from "../src/store.js";
import type { NetworkFault, RunResult, Scenario, Step } from "../src/types.js";

// ---- validation / normalization ----

test("normalizeNetworkFault: defaults to times 1 and writes the default 503 for mode status", () => {
  assert.deepEqual(normalizeNetworkFault({ urlGlob: "**/a.ts", mode: "abort" }), {
    urlGlob: "**/a.ts",
    mode: "abort",
    times: 1,
  });
  assert.deepEqual(normalizeNetworkFault({ urlGlob: "**/a", mode: "status", durationMs: 500 }), {
    urlGlob: "**/a",
    mode: "status",
    status: 503,
    durationMs: 500,
  });
  assert.deepEqual(
    normalizeNetworkFault({ urlGlob: "**/a", mode: "status", status: 429, times: 3, resourceTypes: ["xhr", "xhr"] }),
    { urlGlob: "**/a", mode: "status", status: 429, times: 3, resourceTypes: ["xhr"] }
  );
});

test("normalizeNetworkFault: rejects every malformed field loudly", () => {
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ mode: "abort" }, /"urlGlob" must be a non-empty string/],
    [{ urlGlob: "", mode: "abort" }, /"urlGlob" must be a non-empty string/],
    [{ urlGlob: "**/a", mode: "drop" }, /"mode" must be "abort" or "status"/],
    [{ urlGlob: "**/a" }, /"mode" must be "abort" or "status"/],
    [{ urlGlob: "**/a", mode: "abort", status: 503 }, /only allowed with mode "status"/],
    [{ urlGlob: "**/a", mode: "status", status: 200 }, /HTTP error code \(400-599\)/],
    [{ urlGlob: "**/a", mode: "abort", times: 1, durationMs: 10 }, /exactly one of "times" or "durationMs"/],
    [{ urlGlob: "**/a", mode: "abort", times: 0 }, /"times" must be a positive integer/],
    [{ urlGlob: "**/a", mode: "abort", times: 1.5 }, /"times" must be a positive integer/],
    [{ urlGlob: "**/a", mode: "abort", durationMs: -1 }, /"durationMs" must be a positive integer/],
    [{ urlGlob: "**/a", mode: "abort", resourceTypes: [] }, /non-empty array/],
    [{ urlGlob: "**/a", mode: "abort", resourceTypes: ["websocket"] }, /unknown resource type "websocket"/],
    [{ urlGlob: "**/a", mode: "abort", urlPattern: "x" }, /unknown field\(s\) urlPattern/],
  ];
  for (const [raw, re] of bad) assert.throws(() => normalizeNetworkFault(raw), re, JSON.stringify(raw));
});

test("parseSteps: validates failNetwork, passes other kinds through, rejects unknown kinds", () => {
  const steps = parseSteps(
    [
      { kind: "navigate", url: "/" },
      { kind: "failNetwork", urlGlob: "**/*.ts", mode: "abort" },
      { kind: "assertNetwork", urlGlob: "**/*.ts", injected: true },
    ],
    "x.json"
  );
  assert.deepEqual(steps[1], { kind: "failNetwork", urlGlob: "**/*.ts", mode: "abort", times: 1 });
  assert.deepEqual(steps[2], { kind: "assertNetwork", urlGlob: "**/*.ts", injected: true });

  assert.throws(() => parseSteps({}, "x.json"), /x\.json: a script must be a JSON array/);
  assert.throws(() => parseSteps([{ kind: "teleport" }], "x.json"), /x\.json step 1: unknown step kind "teleport"/);
  assert.throws(
    () => parseSteps([{ kind: "navigate", url: "/" }, { kind: "failNetwork", urlGlob: "**/a", mode: "abort", times: 1, durationMs: 5 }], "x.json"),
    /x\.json step 2 \(failNetwork\): set exactly one of "times" or "durationMs"/
  );
});

test("the shipped example script parses", () => {
  const raw = JSON.parse(fs.readFileSync(new URL("../examples/fail-network.script.json", import.meta.url), "utf8"));
  const steps = parseSteps(raw, "examples/fail-network.script.json");
  assert.ok(steps.some((s) => s.kind === "failNetwork"));
});

test("Store.loadSteps validates the script on load", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scout-store-"));
  try {
    const store = new Store(cwd);
    const file = store.scriptPath("f/s", "mobile");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([{ kind: "failNetwork", urlGlob: "**/a", mode: "abort" }]));
    assert.deepEqual(store.loadSteps("f/s", "mobile"), [
      { kind: "failNetwork", urlGlob: "**/a", mode: "abort", times: 1 },
    ]);
    fs.writeFileSync(file, JSON.stringify([{ kind: "failNetwork", urlGlob: "**/a" }]));
    assert.throws(() => store.loadSteps("f/s", "mobile"), /f\/s@mobile\.json step 1 \(failNetwork\): "mode"/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ---- URL matching (shared with assertNetwork) ----

test("globToRegex: {a,b} alternation matches HLS/DASH segment URLs", () => {
  const re = globToRegex("**/*.{ts,m4s}");
  assert.ok(re.test("https://cdn.test/hls/720p/seg-00042.ts"));
  assert.ok(re.test("https://cdn.test/dash/chunk-3.m4s?token=abc"));
  assert.ok(!re.test("https://cdn.test/hls/720p/index.m3u8"));
  // alternatives may carry wildcards; a comma-less brace stays literal
  assert.ok(globToRegex("**/{api/*/feed,feed}").test("https://x.test/api/v2/feed"));
  assert.ok(globToRegex("**/a{b}").test("https://x.test/a{b}"));
  assert.ok(!globToRegex("**/a{b}").test("https://x.test/ab"));
});

const req = (url: string, status: number, extra: Partial<CapturedRequest> = {}): CapturedRequest => ({
  method: "GET",
  url,
  status,
  getBody: async () => "",
  ...extra,
});

test("matchNetwork: injected entries are invisible by default and the only match for injected=true", async () => {
  const entries = [
    req("https://x.test/seg-1.ts", 0, { injected: true, failure: "net::ERR_FAILED" }),
    req("https://x.test/seg-1.ts", 200),
    req("https://x.test/seg-2.ts", 503, { injected: true }),
  ];
  assert.equal((await matchNetwork(entries, { urlGlob: "**/seg-1.ts", injected: true })).ok, true);
  assert.equal((await matchNetwork(entries, { urlGlob: "**/seg-1.ts", status: 200 })).ok, true);
  // a plain assertion never passes on a fabricated 503
  const plain = await matchNetwork(entries, { urlGlob: "**/seg-2.ts", status: 503 });
  assert.equal(plain.ok, false);
  assert.equal((await matchNetwork(entries, { urlGlob: "**/seg-2.ts", status: "5xx", injected: true })).ok, true);
  // injected=true never matches real traffic
  const real = await matchNetwork([req("https://x.test/seg-3.ts", 200)], { urlGlob: "**/seg-3.ts", injected: true });
  assert.equal(real.ok, false);
  assert.match(real.reason ?? "", /\[injected by failNetwork\]/);
});

// ---- reporting / budget accounting ----

const fault = (f: Partial<NetworkFault> = {}): NetworkFault => ({ urlGlob: "**/*.ts", mode: "abort", times: 1, ...f });

test("describeStep renders each scope and mode", () => {
  assert.equal(
    describeStep({ kind: "failNetwork", ...fault({ resourceTypes: ["xhr", "fetch"] }) }),
    "fail network: abort next 1 xhr/fetch request(s) matching **/*.ts"
  );
  assert.equal(
    describeStep({ kind: "failNetwork", urlGlob: "**/api", mode: "status", status: 503, durationMs: 2000 }),
    "fail network: respond 503 to every request matching **/api for 2000ms"
  );
});

/** Session stub whose executeStep is a no-op and whose faults are scripted. */
function stubSession(outcomes: FaultOutcome[]): BrowserSession {
  return {
    executeStep: async () => {},
    screenshot: async () => "",
    settleNetworkFaults: async () => {},
    networkFaults: () => outcomes,
  } as unknown as BrowserSession;
}

test("collectFaultReports pairs each fault with the step that installed it", () => {
  const steps: Step[] = [
    { kind: "navigate", url: "/" },
    { kind: "failNetwork", ...fault() },
    { kind: "press", key: "Enter" },
    { kind: "failNetwork", ...fault({ times: 3 }) },
  ];
  const reports = collectFaultReports(
    stubSession([
      { fault: fault(), failed: 1 },
      { fault: fault({ times: 3 }), failed: 2, warning: "Only 2 of 3 budgeted request(s) were failed." },
    ]),
    steps,
    [1, 3]
  );
  assert.deepEqual(
    reports.map((r) => [r.step, r.failed, r.warning]),
    [
      [2, 1, undefined],
      [4, 2, "Only 2 of 3 budgeted request(s) were failed."],
    ]
  );
});

test("replaySteps fails at a fault that failed nothing, and passes when every fault fired", async () => {
  const steps: Step[] = [{ kind: "navigate", url: "/" }, { kind: "failNetwork", ...fault() }];
  const missed = await replaySteps(stubSession([{ fault: fault(), failed: 0, warning: "No request matched **/*.ts" }]), steps);
  assert.equal(missed.passed, false);
  assert.equal(missed.failedIndex, 1);
  assert.equal(missed.error, "No request matched **/*.ts");
  assert.equal(missed.networkFaults?.[0].failed, 0);

  const fired = await replaySteps(stubSession([{ fault: fault(), failed: 1 }]), steps);
  assert.equal(fired.passed, true);
  assert.deepEqual(fired.networkFaults, [
    { step: 2, description: "fail network: abort next 1 request(s) matching **/*.ts", failed: 1 },
  ]);

  const none = await replaySteps(stubSession([]), [{ kind: "navigate", url: "/" }]);
  assert.equal("networkFaults" in none, false);
});

test("renderRunReport lists network faults with their counts and warnings", () => {
  const result: RunResult = {
    slug: "f/s",
    viewport: "mobile",
    mode: "replay",
    verdict: "verified",
    reason: "ok",
    runDir: "",
    startedAt: "2026-10-24T00:00:00.000Z",
    durationMs: 1,
    screenshots: [],
    networkFaults: [{ step: 3, description: "fail network: abort next 2 request(s) matching **/*.ts", failed: 1, warning: "Only 1 of 2 budgeted request(s) were failed." }],
  };
  const scenario = { slug: "f/s", name: "s", scenario: "x", feature: "f", file: "f" } as Scenario;
  const md = renderRunReport(result, scenario);
  assert.match(md, /## Network faults/);
  assert.match(md, /\| 3 \| fail network: abort next 2 request\(s\) matching \*\*\/\*\.ts \| 1 \| ⚠️ Only 1 of 2/);
});

// ---- spec frontmatter ----

test("serviceWorkers: file default, per-section override, absent when unset, typo fails", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scout-sw-"));
  const root = path.join(cwd, ".scout", "specs");
  fs.mkdirSync(root, { recursive: true });
  try {
    const file = path.join(root, "player.scout.md");
    fs.writeFileSync(
      file,
      `---\nfeature: Player\nserviceWorkers: block\n---\n\n## Segment drop\nplays on\n\n## PWA install\nserviceWorkers: allow\n\nprompt shows\n`
    );
    const [drop, pwa] = parseSpec(file, root, cwd);
    assert.equal(drop.serviceWorkers, "block");
    assert.equal(pwa.serviceWorkers, "allow");

    fs.writeFileSync(file, `---\nfeature: Player\n---\n\n## Plain\nplays\n`);
    assert.equal("serviceWorkers" in parseSpec(file, root, cwd)[0], false);

    fs.writeFileSync(file, `---\nfeature: Player\nserviceWorkers: off\n---\n\n## Plain\nplays\n`);
    assert.throws(() => parseSpec(file, root, cwd), /Invalid serviceWorkers "off"/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("AI run: a verified verdict with an unexercised fault is downgraded to partial", () => {
  const ok = { verdict: "verified" as const, reason: "video kept playing" };
  const fired = [{ step: 2, description: "fail network: abort next 1 request(s) matching **/*.ts", failed: 1 }];
  assert.deepEqual(guardUnexercisedFaults(ok, fired), ok);
  assert.deepEqual(guardUnexercisedFaults(ok, []), ok);
  const missed = guardUnexercisedFaults(ok, [{ ...fired[0], failed: 0, warning: "No request matched **/*.ts" }]);
  assert.equal(missed.verdict, "partial");
  assert.match(missed.reason, /video kept playing — but step 2 .* never failed a request: No request matched/);
  // A non-verified verdict is the agent's own judgment and stays as is.
  const failed = { verdict: "failed" as const, reason: "stalled" };
  assert.deepEqual(guardUnexercisedFaults(failed, [{ ...fired[0], failed: 0 }]), failed);
});

test("parseSteps: setOffline needs a boolean, assertNetwork.timeout is optional and validated", () => {
  assert.deepEqual(parseSteps([{ kind: "setOffline", offline: true }]), [{ kind: "setOffline", offline: true }]);
  assert.throws(() => parseSteps([{ kind: "setOffline" }]), /"offline" must be true or false/);
  assert.throws(() => parseSteps([{ kind: "setOffline", offline: "yes" }]), /"offline" must be true or false/);
  assert.throws(
    () => parseSteps([{ kind: "assertNetwork", urlGlob: "**/*.ts", timeout: -1 }]),
    /"timeout" must be a non-negative integer/
  );
  assert.equal(describeStep({ kind: "setOffline", offline: true }), "go offline");
  assert.equal(describeStep({ kind: "setOffline", offline: false }), "go back online");
});

test("parseSteps: a script recorded by 0.17 (assertNetwork without timeout) loads unchanged", () => {
  const recorded = [
    { kind: "navigate", url: "/pt/assistir/sinal-fechado-01" },
    { kind: "click", target: { role: "button", name: "Rejeitar", description: 'button "Rejeitar"' } },
    {
      kind: "assertState",
      target: { testId: "player-wrapper", description: '[data-testid="player-wrapper"]' },
      attribute: { name: "data-testid", value: "player-wrapper" },
    },
    { kind: "failNetwork", urlGlob: "**/*.ts", mode: "abort", times: 1 },
    {
      kind: "assertState",
      target: { css: "button[aria-label='Pausar']", description: "button[aria-label='Pausar']" },
      attribute: { name: "aria-label", value: "Pausar" },
    },
    { kind: "assertNetwork", urlGlob: "**/*.ts", status: 0, injected: true },
    { kind: "screenshot", label: "video-playing-after-injected-abort" },
  ];
  assert.deepEqual(parseSteps(structuredClone(recorded)), recorded);
});
