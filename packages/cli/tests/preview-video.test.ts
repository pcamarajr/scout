import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  nonPacedPacing,
  recordPreviewVideoFrom,
  type RecordedReplay,
} from "../src/engine.js";
import { pacingFor, type VideoPacing } from "../src/runner/video.js";
import type { Scenario } from "../src/types.js";

const SCENARIO = { slug: "login", name: "Login flow" } as Scenario;
const TIMELINE = [{ label: "1/1 · navigate to /login", tMs: 100 }];

/** Captures console.warn for the duration of `fn`. */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

/** Writes a placeholder WebM in `runDir` and returns its path (no ffmpeg needed). */
function writeWebm(runDir: string): string {
  const webm = path.join(runDir, `raw-${Math.random().toString(36).slice(2)}.webm`);
  fs.writeFileSync(webm, "webm-bytes");
  return webm;
}

function withRunDir<T>(fn: (runDir: string) => Promise<T>): Promise<T> {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-preview-"));
  return fn(runDir).finally(() => fs.rmSync(runDir, { recursive: true, force: true }));
}

test("nonPacedPacing zeroes slowMo and dwell but keeps the cards", () => {
  const paced = pacingFor(0.4);
  const plain = nonPacedPacing(paced);
  assert.equal(plain.slowMoMs, 0);
  assert.equal(plain.assertDwellMs, 0);
  assert.equal(plain.titleCardMs, paced.titleCardMs);
  assert.equal(plain.verdictCardMs, paced.verdictCardMs);
});

test("paced replay passing yields a clip and never invokes the fallback", async () => {
  await withRunDir(async (runDir) => {
    const pacings: VideoPacing[] = [];
    const attempt = async (pacing: VideoPacing): Promise<RecordedReplay> => {
      pacings.push(pacing);
      return { passed: true, webm: writeWebm(runDir), timeline: TIMELINE };
    };
    const out = await recordPreviewVideoFrom(attempt, SCENARIO, runDir, pacingFor(0.4));
    assert.ok(out, "a clip path must be returned");
    assert.ok(fs.existsSync(out!), "the clip must exist on disk");
    assert.equal(pacings.length, 1, "fallback must not run when the paced replay passes");
    assert.ok(pacings[0].slowMoMs > 0, "the single attempt must be paced");
  });
});

test("paced replay failing falls back to a non-paced clip (verdict unaffected)", async () => {
  await withRunDir(async (runDir) => {
    const pacings: VideoPacing[] = [];
    // First (paced) attempt fails; the non-paced fallback passes — mirroring the
    // authoritative replay that already produced the "verified" verdict.
    const attempt = async (pacing: VideoPacing): Promise<RecordedReplay> => {
      pacings.push(pacing);
      const passed = pacing.slowMoMs === 0; // only the non-paced attempt passes
      return { passed, webm: writeWebm(runDir), timeline: TIMELINE };
    };

    let out: string | undefined;
    const warnings = await captureWarnings(async () => {
      out = await recordPreviewVideoFrom(attempt, SCENARIO, runDir, pacingFor(0.4));
    });

    assert.ok(out, "a fallback clip must still be produced");
    assert.ok(fs.existsSync(out!), "the fallback clip must exist on disk");
    assert.equal(pacings.length, 2, "paced attempt then non-paced fallback");
    assert.ok(pacings[0].slowMoMs > 0, "first attempt is paced");
    assert.equal(pacings[1].slowMoMs, 0, "fallback attempt is non-paced");
    assert.ok(
      warnings.some((w) => /paced preview replay failed; recorded a non-paced fallback/.test(w)),
      "a clear fallback warning must be emitted"
    );
  });
});

test("failed paced WebM is discarded, not rendered, when falling back", async () => {
  await withRunDir(async (runDir) => {
    const webmPaths: string[] = [];
    const attempt = async (pacing: VideoPacing): Promise<RecordedReplay> => {
      const webm = writeWebm(runDir);
      webmPaths.push(webm);
      return { passed: pacing.slowMoMs === 0, webm, timeline: TIMELINE };
    };
    await captureWarnings(async () => {
      await recordPreviewVideoFrom(attempt, SCENARIO, runDir, pacingFor(0.4));
    });
    assert.ok(!fs.existsSync(webmPaths[0]), "the failed paced WebM must be removed");
  });
});

test("both attempts failing yields no video and warns (verdict unaffected)", async () => {
  await withRunDir(async (runDir) => {
    const attempt = async (): Promise<RecordedReplay> => ({
      passed: false,
      webm: writeWebm(runDir),
      timeline: TIMELINE,
    });
    let out: string | undefined = "sentinel";
    const warnings = await captureWarnings(async () => {
      out = await recordPreviewVideoFrom(attempt, SCENARIO, runDir, pacingFor(0.4));
    });
    assert.equal(out, undefined, "no clip when both attempts fail");
    assert.ok(
      warnings.some((w) => /non-paced fallback replay also failed/.test(w)),
      "the final no-video warning must be emitted"
    );
  });
});
