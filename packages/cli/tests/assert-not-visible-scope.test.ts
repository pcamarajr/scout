import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { chromium } from "playwright";
import { BrowserSession, buildSelectorTarget, closeBrowsers } from "../src/runner/browser.js";
import type { ResolvedViewport } from "../src/viewports.js";

/**
 * Real-browser proof for the CONTAINER SCOPE on assertNotVisible. The page-wide
 * form is strictly stronger, so the only things worth proving in a real DOM are
 * the two behaviors that scoping introduces: text present elsewhere no longer
 * trips the check, and a missing container FAILS instead of passing vacuously
 * (the false-green this feature could otherwise create).
 *
 * OPT-IN + auto-skip, mirroring the other browser tests: CI does not
 * `playwright install`, so probe once and skip the file when no browser exists.
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

const VIEWPORT: ResolvedViewport = { name: "desktop", width: 1280, height: 800 };

// BrowserSession.launch draws from the shared Chromium pool; session.close()
// returns the context but leaves the browser alive, so the test process would
// never exit without this.
after(async () => {
  await closeBrowsers();
});

function startPage(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const html = `<!doctype html><html><body>${body}</body></html>`;
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

async function withSession(
  body: string,
  fn: (session: BrowserSession) => Promise<void>
): Promise<void> {
  const page = await startPage(body);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-notvisible-"));
  const session = await BrowserSession.launch({
    baseUrl: page.url,
    headless: true,
    runDir,
    viewport: VIEWPORT,
  });
  try {
    await session.navigate(page.url);
    await fn(session);
  } finally {
    await session.close();
    await page.close();
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

// The motivating page: the same copy renders inside the container AND in an
// unrelated toast, which is exactly what makes the page-wide check unusable.
const SCOPED_PAGE = `
  <div data-testid="cart-summary"><h2>Your cart</h2></div>
  <div data-testid="toast">Out of stock</div>
`;

test("scoped assertNotVisible ignores the same text outside the container", { skip: SKIP }, async () => {
  await withSession(SCOPED_PAGE, async (session) => {
    const within = buildSelectorTarget({ testId: "cart-summary" });
    await session.assertNotVisible("Out of stock", 50, within);
    // Page-wide, the toast makes the identical expectation fail — the gap this closes.
    await assert.rejects(
      () => session.assertNotVisible("Out of stock", 50),
      /is visible, but it should not be/
    );
  });
});

test("scoped assertNotVisible fails when the text IS inside the container", { skip: SKIP }, async () => {
  await withSession(
    `<div data-testid="cart-summary"><p>Out of stock</p></div>`,
    async (session) => {
      await assert.rejects(
        () => session.assertNotVisible("Out of stock", 50, buildSelectorTarget({ testId: "cart-summary" })),
        /is visible inside \[data-testid="cart-summary"\]/
      );
    }
  );
});

test("scoped assertNotVisible fails loudly when the container is absent", { skip: SKIP }, async () => {
  // Without this guard a container that never rendered would report a clean check.
  await withSession(`<div data-testid="toast">Out of stock</div>`, async (session) => {
    await assert.rejects(
      () => session.assertNotVisible("Out of stock", 50, buildSelectorTarget({ testId: "cart-summary" })),
      /is not in the DOM/
    );
  });
});

test("scoped assertNotVisible replays from a recorded step", { skip: SKIP }, async () => {
  await withSession(SCOPED_PAGE, async (session) => {
    await session.executeStep({
      kind: "assertNotVisible",
      text: "Out of stock",
      timeout: 50,
      target: buildSelectorTarget({ testId: "cart-summary" }),
    });
  });
});

test("a css container scopes the check too", { skip: SKIP }, async () => {
  await withSession(SCOPED_PAGE, async (session) => {
    const within = buildSelectorTarget({ css: '[data-testid="cart-summary"]' });
    await session.assertNotVisible("Out of stock", 50, within);
  });
});
