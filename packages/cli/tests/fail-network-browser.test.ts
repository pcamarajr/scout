import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { chromium } from "playwright";
import { BrowserSession, closeBrowsers } from "../src/runner/browser.js";
import { replaySteps } from "../src/runner/script-runner.js";
import { parseSteps } from "../src/runner/step-schema.js";
import type { Step, Target } from "../src/types.js";
import type { ResolvedViewport } from "../src/viewports.js";

/**
 * Real-browser proof for the `failNetwork` step against a tiny local fixture
 * that mimics an HLS player: segments (`.ts`, `.m4s`) are fetched by page
 * script and retried on failure. Proves the glob matches segment URLs, the
 * budget is exact, the retry after the fault succeeds, the fault is observable
 * by assertNetwork, a never-matching fault fails the replay, replay is
 * deterministic, and nothing leaks into the next session.
 *
 * Auto-skips when no Chromium is installed (CI does not `playwright install`).
 */

const browserAvailable = await (async () => {
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
    return true;
  } catch {
    return false;
  }
})();
const SKIP = browserAvailable ? false : "no Chromium available (run `npx playwright install chromium`)";

const VIEWPORT: ResolvedViewport = { name: "mobile", width: 390, height: 844 };
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scout-fail-network-"));

after(async () => {
  await closeBrowsers();
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
});

const button = (name: string): Target => ({ role: "button", name, description: `button "${name}"` });

/**
 * The fixture page. "Load" fetches seg-1.ts then seg-2.m4s, each retried (up to
 * 20 attempts, 50ms apart) on a network error or non-2xx — the way an HLS
 * player recovers a transient segment failure — and paints each segment's
 * outcome plus how many attempts it took. "Popup" opens a tab that fetches a
 * segment once, with no retry.
 */
const PAGE = `<!doctype html><html><body>
  <button onclick="load()">Load</button>
  <button onclick="window.open('/popup')">Popup</button>
  <div id="out"></div>
  <script>
    async function get(url) {
      for (let attempt = 1; attempt <= 20; attempt++) {
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (res.ok) return 'ok/' + attempt + ':' + (await res.text());
        } catch (e) {}
        await new Promise((r) => setTimeout(r, 50));
      }
      return 'gave-up';
    }
    async function load() {
      const a = await get('/hls/seg-1.ts');
      const b = await get('/hls/seg-2.m4s');
      document.getElementById('out').textContent = 'seg-1=' + a + ' seg-2=' + b + ' done';
    }
  </script>
</body></html>`;

const POPUP = `<!doctype html><html><body><div id="pop"></div><script>
  fetch('/hls/pop.ts', { cache: 'no-store' })
    .then((r) => { document.getElementById('pop').textContent = 'pop=' + r.status; })
    .catch(() => { document.getElementById('pop').textContent = 'pop=failed'; });
</script></body></html>`;

/**
 * The race the HotShort replay hit: the ready marker is visible at once, the
 * segment is requested only `delay` ms later — so the assertion step runs
 * before the fault has fired.
 */
const racePage = (delay: number): string => `<!doctype html><html><body>
  <div id="ready">ready</div>
  <script>setTimeout(() => fetch('/hls/seg_000.ts', { cache: 'no-store' }).catch(() => {}), ${delay});</script>
</body></html>`;

/** Paints navigator.onLine and every online/offline event the page receives. */
const OFFLINE_PAGE = `<!doctype html><html><body><div id="net"></div><div id="events"></div><script>
  const paint = () => { document.getElementById('net').textContent = navigator.onLine ? 'net=online' : 'net=offline'; };
  const log = (e) => { document.getElementById('events').textContent += ' ' + e.type; paint(); };
  addEventListener('online', log);
  addEventListener('offline', log);
  paint();
</script></body></html>`;

/** Page that registers a pass-through service worker before offering "Load". */
const SW_PAGE = PAGE.replace(
  "<script>",
  `<div id="sw"></div><script>
    navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready)
      .then(() => { document.getElementById('sw').textContent = navigator.serviceWorker.controller ? 'sw=controlled' : 'sw=reload'; });
  `
);
const SW_JS = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => { if (e.request.url.includes('/hls/')) e.respondWith(fetch(e.request)); });`;

interface Fixture {
  url: string;
  /** Requests that actually reached the server, per path. */
  hits: Map<string, number>;
  close: () => Promise<void>;
}

function startFixture(): Promise<Fixture> {
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    hits.set(p, (hits.get(p) ?? 0) + 1);
    const send = (type: string, body: string): void => {
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (p === "/") return send("text/html", PAGE);
    if (p === "/popup") return send("text/html", POPUP);
    if (p === "/sw") return send("text/html", SW_PAGE);
    if (p === "/sw.js") return send("text/javascript", SW_JS);
    if (p === "/race") return send("text/html", racePage(Number(new URL(req.url ?? "/", "http://x").searchParams.get("delay") ?? 0)));
    if (p === "/offline") return send("text/html", OFFLINE_PAGE);
    if (p.startsWith("/hls/")) return send("video/mp2t", `DATA${path.basename(p)}`);
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        hits,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

async function withSession<T>(
  fixture: Fixture,
  fn: (s: BrowserSession) => Promise<T>,
  serviceWorkers?: "allow" | "block"
): Promise<T> {
  const session = await BrowserSession.launch({
    baseUrl: fixture.url,
    headless: true,
    runDir: RUN_DIR,
    viewport: VIEWPORT,
    serviceWorkers,
  });
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

const outText = (s: BrowserSession): Promise<string> => s.page.locator("#out").innerText();

/** The script under test: arm one abort on any segment, then play. */
const ABORT_ONCE: Step[] = parseSteps([
  { kind: "navigate", url: "/" },
  { kind: "failNetwork", urlGlob: "**/*.{ts,m4s}", mode: "abort", resourceTypes: ["fetch"] },
  { kind: "click", target: button("Load") },
  { kind: "waitForText", text: "done" },
  { kind: "assertNetwork", urlGlob: "**/seg-1.ts", injected: true },
  { kind: "assertNetwork", urlGlob: "**/seg-1.ts", status: 200 },
]);

test("aborts exactly one matching segment; the retry succeeds and later segments are untouched", { skip: SKIP }, async () => {
  const fixture = await startFixture();
  try {
    await withSession(fixture, async (s) => {
      const replay = await replaySteps(s, ABORT_ONCE);
      assert.equal(replay.passed, true, replay.error);
      // seg-1 needed a 2nd attempt; seg-2 (.m4s, also matching) loaded first try
      // because the times:1 budget was already spent and the route removed.
      assert.equal(await outText(s), "seg-1=ok/2:DATAseg-1.ts seg-2=ok/1:DATAseg-2.m4s done");
      assert.deepEqual(replay.networkFaults, [
        {
          step: 2,
          description: "fail network: abort next 1 fetch request(s) matching **/*.{ts,m4s}",
          failed: 1,
        },
      ]);
      // The aborted request never reached the server.
      assert.equal(fixture.hits.get("/hls/seg-1.ts"), 1);
      assert.equal(fixture.hits.get("/hls/seg-2.m4s"), 1);
      // Only the injected entry is visible to injected:true, and it is marked.
      await assert.rejects(
        s.assertNetwork({ urlGlob: "**/seg-2.m4s", injected: true }, 200),
        /No observed request matched .*injected by failNetwork.*\(waited \d+ms\)/
      );
      assert.match(s.formatLogs(), /GET ABORTED \(net::ERR_FAILED\) .*seg-1\.ts \[injected by failNetwork\]/);
      assert.match(s.formatLogs(), /#1 abort \*\*\/\*\.\{ts,m4s\} — failed 1\/1/);
    });
  } finally {
    await fixture.close();
  }
});

test("mode status fulfills the budgeted requests with the HTTP status, marked injected", { skip: SKIP }, async () => {
  const fixture = await startFixture();
  try {
    await withSession(fixture, async (s) => {
      const replay = await replaySteps(
        s,
        parseSteps([
          { kind: "navigate", url: "/" },
          { kind: "failNetwork", urlGlob: "**/seg-1.ts", mode: "status", times: 2 },
          { kind: "click", target: button("Load") },
          { kind: "waitForText", text: "done" },
          { kind: "assertNetwork", urlGlob: "**/seg-1.ts", status: 503, injected: true },
        ])
      );
      assert.equal(replay.passed, true, replay.error);
      assert.match(await outText(s), /^seg-1=ok\/3:/);
      assert.equal(replay.networkFaults?.[0].failed, 2);
      assert.equal(fixture.hits.get("/hls/seg-1.ts"), 1);
      // A plain assertion never matches the fabricated 503s.
      await assert.rejects(s.assertNetwork({ urlGlob: "**/seg-1.ts", status: 503 }, 200), /No observed request/);
    });
  } finally {
    await fixture.close();
  }
});

test("durationMs fails every match inside the window, then stops", { skip: SKIP }, async () => {
  const fixture = await startFixture();
  try {
    await withSession(fixture, async (s) => {
      await s.navigate("/");
      await s.executeStep({ kind: "failNetwork", urlGlob: "**/seg-1.ts", mode: "abort", durationMs: 400 });
      await s.executeStep({ kind: "click", target: button("Load") });
      await s.waitForText("done");
      const [fault] = s.networkFaults();
      assert.ok(fault.failed >= 2, `expected several aborts in the window, got ${fault.failed}`);
      assert.equal(fault.warning, undefined);
      assert.match(await outText(s), new RegExp(`^seg-1=ok/${fault.failed + 1}:`));
    });
  } finally {
    await fixture.close();
  }
});

test("a fault that never matches fails the replay at that step — not a silent pass", { skip: SKIP }, async () => {
  const fixture = await startFixture();
  try {
    await withSession(fixture, async (s) => {
      const replay = await replaySteps(
        s,
        parseSteps([
          { kind: "navigate", url: "/" },
          { kind: "failNetwork", urlGlob: "**/does-not-exist.ts", mode: "abort" },
          { kind: "click", target: button("Load") },
          { kind: "waitForText", text: "done" },
        ])
      );
      assert.equal(replay.passed, false);
      assert.equal(replay.failedIndex, 1);
      assert.match(replay.failedStep ?? "", /does-not-exist/);
      assert.match(replay.error ?? "", /No request matched \*\*\/does-not-exist\.ts/);
      assert.equal(replay.networkFaults?.[0].failed, 0);
    });
  } finally {
    await fixture.close();
  }
});

test("replay is deterministic and no handler leaks into the next session", { skip: SKIP }, async () => {
  const fixture = await startFixture();
  try {
    const runs: { text: string; faults: unknown }[] = [];
    for (let i = 0; i < 2; i++) {
      await withSession(fixture, async (s) => {
        const replay = await replaySteps(s, ABORT_ONCE);
        assert.equal(replay.passed, true, replay.error);
        runs.push({ text: await outText(s), faults: replay.networkFaults });
      });
    }
    assert.deepEqual(runs[0], runs[1]);
    // A following session (pooled browser, new context) without the step plays clean.
    await withSession(fixture, async (s) => {
      await s.navigate("/");
      await s.executeStep({ kind: "click", target: button("Load") });
      await s.waitForText("done");
      assert.equal(await outText(s), "seg-1=ok/1:DATAseg-1.ts seg-2=ok/1:DATAseg-2.m4s done");
      assert.deepEqual(s.networkFaults(), []);
    });
  } finally {
    await fixture.close();
  }
});

test("context-level routing covers a popup opened after the step (switchTab)", { skip: SKIP }, async () => {
  const fixture = await startFixture();
  try {
    await withSession(fixture, async (s) => {
      const replay = await replaySteps(
        s,
        parseSteps([
          { kind: "navigate", url: "/" },
          { kind: "failNetwork", urlGlob: "**/pop.ts", mode: "abort" },
          { kind: "click", target: button("Popup") },
          { kind: "switchTab", urlGlob: "**/popup" },
          { kind: "waitForText", text: "pop=failed" },
          { kind: "assertNetwork", urlGlob: "**/pop.ts", injected: true },
        ])
      );
      assert.equal(replay.passed, true, replay.error);
      assert.equal(replay.networkFaults?.[0].failed, 1);
    });
  } finally {
    await fixture.close();
  }
});

test("service workers: allowed → worker fetches are still failed but flagged; block → plain page fetches", { skip: SKIP }, async () => {
  const fixture = await startFixture();
  try {
    // Default (allow) with a pass-through worker. Verified on Playwright 1.60 /
    // Chromium: context.route DOES see the worker's own network fetch, so the
    // fault fires — but a worker answering from Cache Storage would bypass it,
    // so the report carries a service-worker warning either way.
    await withSession(fixture, async (s) => {
      await s.navigate("/sw");
      await s.page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 2_000 })
        .catch(() => s.page.reload());
      await s.page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await s.executeStep({ kind: "failNetwork", urlGlob: "**/seg-1.ts", mode: "abort", resourceTypes: ["fetch"] });
      await s.executeStep({ kind: "click", target: button("Load") });
      await s.waitForText("done");
      const [fault] = s.networkFaults();
      assert.equal(fault.failed, 1);
      assert.match(fault.warning ?? "", /service worker/);
      assert.match(await outText(s), /^seg-1=ok\/2:/);
      // The worker-originated abort is still observable on the active tab.
      await s.assertNetwork({ urlGlob: "**/seg-1.ts", injected: true });
    });

    // serviceWorkers=block: no worker, the page's own fetch is failed, no warning.
    await withSession(
      fixture,
      async (s) => {
        await s.navigate("/sw");
        assert.equal(await s.page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), false);
        await s.executeStep({ kind: "failNetwork", urlGlob: "**/seg-1.ts", mode: "abort", resourceTypes: ["fetch"] });
        await s.executeStep({ kind: "click", target: button("Load") });
        await s.waitForText("done");
        assert.deepEqual(s.networkFaults()[0].failed, 1);
        assert.equal(s.networkFaults()[0].warning, undefined);
        assert.match(await outText(s), /^seg-1=ok\/2:/);
        await s.assertNetwork({ urlGlob: "**/seg-1.ts", injected: true });
      },
      "block"
    );
  } finally {
    await fixture.close();
  }
});

/** The generic HotShort repro: assert the fault right after an unrelated ready marker. */
const raceScript = (delay: number, mode: "abort" | "status"): Step[] =>
  parseSteps([
    { kind: "navigate", url: `/race?delay=${delay}` },
    mode === "abort"
      ? { kind: "failNetwork", urlGlob: "**/*.ts", mode: "abort", times: 1 }
      : { kind: "failNetwork", urlGlob: "**/*.ts", mode: "status", status: 503, times: 1 },
    { kind: "assertVisible", text: "ready" },
    // Recorded by 0.17 — no timeout field.
    { kind: "assertNetwork", urlGlob: "**/*.ts", status: mode === "abort" ? 0 : 503, injected: true },
  ]);

for (const mode of ["abort", "status"] as const) {
  test(`assertNetwork injected=true waits for a fault that fires after the step starts (${mode})`, { skip: SKIP }, async () => {
    const fixture = await startFixture();
    try {
      for (const delay of [50, 150, 300, 500]) {
        for (let i = 0; i < 3; i++) {
          await withSession(fixture, async (s) => {
            const replay = await replaySteps(s, raceScript(delay, mode));
            assert.equal(replay.passed, true, `delay ${delay}ms run ${i + 1}: ${replay.error}`);
            assert.equal(replay.networkFaults?.[0].failed, 1);
          });
        }
      }
    } finally {
      await fixture.close();
    }
  });
}

test("assertNetwork injected=true cannot pass before the fault fires, and passes once it fires within the timeout", { skip: SKIP }, async () => {
  const fixture = await startFixture();
  try {
    await withSession(fixture, async (s) => {
      await s.navigate("/");
      await s.executeStep({ kind: "failNetwork", urlGlob: "**/seg-1.ts", mode: "abort", times: 1 });
      // Nothing requested yet: an immediate check fails.
      await assert.rejects(s.assertNetwork({ urlGlob: "**/seg-1.ts", injected: true }, 0), /No observed request/);
      let settled = false;
      const pending = s.assertNetwork({ urlGlob: "**/seg-1.ts", status: 0, injected: true }, 5_000).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(settled, false, "the assertion must still be waiting — the fault has not fired");
      assert.equal(s.networkFaults()[0].failed, 0);
      await s.executeStep({ kind: "click", target: button("Load") });
      await pending;
      assert.equal(s.networkFaults()[0].failed, 1);
    });
  } finally {
    await fixture.close();
  }
});

test("a fault that never fires fails the replay at the injected assertion, saying how long it waited", { skip: SKIP }, async () => {
  const fixture = await startFixture();
  try {
    await withSession(fixture, async (s) => {
      const replay = await replaySteps(
        s,
        parseSteps([
          { kind: "navigate", url: "/race?delay=50" },
          { kind: "failNetwork", urlGlob: "**/never.ts", mode: "abort" },
          { kind: "assertVisible", text: "ready" },
          { kind: "assertNetwork", urlGlob: "**/*.ts", injected: true, timeout: 500 },
        ])
      );
      assert.equal(replay.passed, false);
      assert.equal(replay.failedIndex, 3);
      assert.match(replay.error ?? "", /No observed request matched ANY \*\*\/\*\.ts \[injected by failNetwork\]\. \(waited \d+ms\)/);
      assert.equal(replay.networkFaults?.[0].failed, 0);
    });
  } finally {
    await fixture.close();
  }
});

test("the fault report never runs ahead of the network log (page and service-worker requests)", { skip: SKIP }, async () => {
  const fixture = await startFixture();
  try {
    for (const sw of [false, true]) {
      await withSession(fixture, async (s) => {
        await s.navigate(sw ? "/sw" : "/");
        if (sw) {
          await s.page
            .waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 2_000 })
            .catch(() => s.page.reload());
          await s.page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
        }
        await s.executeStep({ kind: "failNetwork", urlGlob: "**/seg-1.ts", mode: "abort", times: 1 });
        await s.executeStep({ kind: "click", target: button("Load") });
        // Spin on the report; the instant it counts the fault, the log must hold it.
        const deadline = Date.now() + 5_000;
        while (s.networkFaults()[0].failed === 0) {
          assert.ok(Date.now() < deadline, "fault never fired");
          await new Promise((r) => setImmediate(r));
        }
        await s.assertNetwork({ urlGlob: "**/seg-1.ts", status: 0, injected: true }, 0);
      });
    }
  } finally {
    await fixture.close();
  }
});

test("setOffline flips navigator.onLine both ways, fires the events, and replays deterministically", { skip: SKIP }, async () => {
  const fixture = await startFixture();
  try {
    const script = parseSteps([
      { kind: "navigate", url: "/offline" },
      { kind: "assertVisible", text: "net=online" },
      { kind: "setOffline", offline: true },
      { kind: "assertVisible", text: "net=offline" },
      { kind: "setOffline", offline: false },
      { kind: "assertVisible", text: "net=online" },
    ]);
    for (let i = 0; i < 2; i++) {
      await withSession(fixture, async (s) => {
        const replay = await replaySteps(s, script);
        assert.equal(replay.passed, true, replay.error);
        assert.equal(await s.page.evaluate(() => navigator.onLine), true);
        assert.equal((await s.page.locator("#events").innerText()).trim(), "offline online");
      });
    }
    // While offline, requests really fail.
    await withSession(fixture, async (s) => {
      await s.navigate("/offline");
      await s.setOffline(true);
      const failed = await s.page.evaluate(() => fetch("/hls/x.ts").then(() => false, () => true));
      assert.equal(failed, true);
    });
  } finally {
    await fixture.close();
  }
});
