import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { BrowserSession } from "../src/runner/browser.js";
import type { ResolvedViewport } from "../src/viewports.js";
import type { Step, Target } from "../src/types.js";

/**
 * Real-browser integration proof for the selector preference ladder: launch a
 * genuine Chromium context, drive the recording path (snapshot → click), and
 * assert the RECORDED Target walked the ladder — testid over positional CSS,
 * uniqueness enforced, accessible name COMPUTED from the live DOM (not guessed),
 * fragility flagged, and deterministic fallback retry on replay.
 *
 * OPT-IN + auto-skip: CI does not `playwright install`, so this probes for a
 * usable browser once and skips the whole file when none is present, keeping
 * default `npm test` green everywhere.
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
  fn: (session: BrowserSession, url: string) => Promise<void>
): Promise<void> {
  const page = await startPage(body);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-ladder-"));
  const session = await BrowserSession.launch({
    baseUrl: page.url,
    headless: true,
    runDir,
    viewport: VIEWPORT,
  });
  try {
    await session.navigate(page.url);
    await fn(session, page.url);
  } finally {
    await session.close();
    await page.close();
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

/** Finds the snapshot ref whose accessible name matches. */
async function refByName(session: BrowserSession, name: string): Promise<number> {
  const snap = await session.snapshot();
  const el = snap.elements.find((e) => e.name === name);
  assert.ok(el, `no snapshot element named "${name}" (got: ${snap.elements.map((e) => e.name).join(", ")})`);
  return el.ref;
}

test("records a testid as primary and keeps role+name / css as fallbacks", { skip: SKIP }, async () => {
  await withSession(`<button data-testid="buy" aria-label="Purchase now">Buy</button>`, async (session) => {
    const ref = await refByName(session, "Purchase now");
    const target = await session.click(ref);
    assert.equal(target.testId, "buy", "testid must win the ladder");
    assert.equal(target.fragile, undefined, "a testid selector is not fragile");
    const roleFallback = target.fallbacks?.find((f) => f.role === "button");
    assert.ok(roleFallback, "role+name should be a recorded fallback");
  });
});

test("records the COMPUTED accessible name, not the visible label", { skip: SKIP }, async () => {
  // The button's visible text is "Buy" but its accessible name is the aria-label
  // "Purchase now". A recorded role+name selector MUST use the computed name —
  // this is the exact divergence that breaks a hand-guessed role/name selector.
  await withSession(`<button data-testid="buy" aria-label="Purchase now">Buy</button>`, async (session) => {
    const ref = await refByName(session, "Purchase now");
    const target = await session.click(ref);
    const roleFallback = target.fallbacks?.find((f) => f.role === "button");
    assert.equal(roleFallback?.name, "Purchase now", "must record the computed accessible name");
    assert.notEqual(roleFallback?.name, "Buy", "must NOT record the visible label");
  });
});

test("drops a non-unique testid and falls to a uniquely-matching rung", { skip: SKIP }, async () => {
  // Two elements share the testid, so it is ambiguous; the ladder must skip it
  // and record a rung that uniquely identifies THIS element.
  await withSession(
    `<button data-testid="row">Alpha</button><button data-testid="row">Beta</button>`,
    async (session) => {
      const ref = await refByName(session, "Alpha");
      const target = await session.click(ref);
      assert.equal(target.testId, undefined, "an ambiguous testid must not be recorded");
      assert.equal(target.role, "button");
      assert.equal(target.name, "Alpha");
      assert.equal(target.fragile, undefined);
    }
  );
});

test("prefers a stable id but rejects an auto-generated one", { skip: SKIP }, async () => {
  await withSession(`<a id="home-link" href="/x">Home</a>`, async (session) => {
    const ref = await refByName(session, "Home");
    const target = await session.click(ref).catch(() => undefined);
    // Navigation may detach the page; re-run on a fresh session for the assertion
    // instead of depending on the post-click state.
    assert.ok(target, "click should return a target");
    assert.equal(target?.css, '[id="home-link"]', "a stable id becomes the primary selector");
    assert.equal(target?.fragile, undefined);
  });
  await withSession(`<a id="radix-9931" href="#">Menu</a>`, async (session) => {
    const ref = await refByName(session, "Menu");
    const target = await session.click(ref);
    assert.notEqual(target.css, '[id="radix-9931"]', "an auto-generated id must be rejected");
  });
});

test("flags a role-less positional-only element as fragile (clickSelector)", { skip: SKIP }, async () => {
  await withSession(`<div class="tap-layer" style="width:80px;height:80px"></div>`, async (session) => {
    const target = await session.clickSelector({ css: "div.tap-layer" });
    assert.equal(target.fragile, true, "a role-less positional selector is fragile");
    assert.ok(target.css, "it still records a css path to replay");
  });
});

test("deterministic replay falls back when the primary selector no longer resolves", { skip: SKIP }, async () => {
  await withSession(`<button id="real">Click me</button>`, async (session) => {
    // Speed up the primary's actionability wait so its failure is quick.
    session.page.setDefaultTimeout(1500);
    const step: Step = {
      kind: "click",
      target: {
        testId: "vanished",
        description: 'testid "vanished"',
        fallbacks: [{ css: "#real", description: "#real" } satisfies Target],
      },
    };
    let note: string | undefined;
    await session.executeStep(step, (n) => (note = n));
    assert.match(note ?? "", /fallback css #real/, "the fallback that resolved must be logged");
  });
});
