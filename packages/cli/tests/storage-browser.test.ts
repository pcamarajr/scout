import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { chromium } from "playwright";
import { BrowserSession, closeBrowsers } from "../src/runner/browser.js";
import type { ResolvedViewport } from "../src/viewports.js";

/**
 * Real-browser integration proof for the `storage` primitive: launch a genuine
 * Chromium context with seeded storage, navigate to a page that reads
 * localStorage/sessionStorage ON LOAD, and assert the seed was in place before
 * the app's own scripts ran. A second case proves `remove` yields a clean state.
 *
 * OPT-IN + auto-skip: CI does not `playwright install`, so this probes for a
 * usable browser once and skips the whole file when none is present (mirroring
 * the live cross-engine harness), keeping default `npm test` green everywhere.
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

// session.close() now closes only the context; the pooled Chromium process
// stays warm. Drain it at file end so the live browser can't keep this test
// process's event loop alive.
after(async () => {
  await closeBrowsers();
});

/**
 * Serves a page that, on load, reads its storage and paints the values into the
 * DOM — so what we assert reflects what the app saw at load time, not a value we
 * poke in afterward.
 */
function startPage(): Promise<{ url: string; close: () => Promise<void> }> {
  const html = `<!doctype html><html><body>
    <div id="local"></div><div id="session"></div><div id="dismissed"></div>
    <script>
      document.getElementById('local').textContent = 'local:' + (localStorage.getItem('hn_app_open_count') || 'none');
      document.getElementById('session').textContent = 'session:' + (sessionStorage.getItem('hn_flag') || 'none');
      document.getElementById('dismissed').textContent = 'dismissed:' + (localStorage.getItem('hn_pwa_prompt_dismissed') || 'absent');
    </script>
  </body></html>`;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test("seeds localStorage + sessionStorage before the app reads them on load", { skip: SKIP }, async () => {
  const page = await startPage();
  const session = await BrowserSession.launch({
    baseUrl: page.url,
    headless: true,
    runDir: "/tmp",
    viewport: VIEWPORT,
    storage: { local: { hn_app_open_count: "3" }, session: { hn_flag: "on" } },
  });
  try {
    await session.navigate("/");
    const snap = await session.snapshot();
    assert.match(snap.text, /local:3/, "localStorage seed must be present at load");
    assert.match(snap.text, /session:on/, "sessionStorage seed must be present at load");
  } finally {
    await session.close();
    await page.close();
  }
});

test("remove yields a clean state (key absent at load)", { skip: SKIP }, async () => {
  const page = await startPage();
  const session = await BrowserSession.launch({
    baseUrl: page.url,
    headless: true,
    runDir: "/tmp",
    viewport: VIEWPORT,
    storage: { remove: ["hn_pwa_prompt_dismissed"] },
  });
  try {
    await session.navigate("/");
    const snap = await session.snapshot();
    // The page reports "absent" when the key is not in localStorage — proving the
    // remove ran before the page script (and didn't leave a stale value behind).
    assert.match(snap.text, /dismissed:absent/, "removed key must be absent at load");
  } finally {
    await session.close();
    await page.close();
  }
});
