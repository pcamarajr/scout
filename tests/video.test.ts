import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildOverlayFilter,
  findFfmpeg,
  generateVideo,
  pacingFor,
  resolveFont,
  type TimelineEntry,
} from "../src/runner/video.js";

const TIMELINE: TimelineEntry[] = [
  { label: "1/2 · navegar para /login", tMs: 200 },
  { label: "2/2 · verificar texto visível \"Dashboard\"", tMs: 2200 },
];

test("pacingFor maps videoSpeed to slowMo/dwell; 1.0 is natural speed", () => {
  assert.deepEqual(pacingFor(1), { slowMoMs: 0, assertDwellMs: 500, titleCardMs: 1500, verdictCardMs: 1800 });
  const slow = pacingFor(0.4);
  assert.equal(slow.slowMoMs, 300);
  assert.equal(slow.assertDwellMs, 1250);
});

test("pacingFor clamps out-of-range speeds and defaults to 0.4", () => {
  assert.equal(pacingFor(5).slowMoMs, 0); // clamped to 1.0
  assert.ok(pacingFor(0).slowMoMs > 0); // clamped to 0.1, very slow
  assert.equal(pacingFor().slowMoMs, pacingFor(0.4).slowMoMs);
});

test("resolveFont honors SCOUT_VIDEO_FONT override", () => {
  const tmp = path.join(os.tmpdir(), "scout-font.ttf");
  fs.writeFileSync(tmp, "not-a-real-font");
  const saved = process.env.SCOUT_VIDEO_FONT;
  process.env.SCOUT_VIDEO_FONT = tmp;
  try {
    assert.equal(resolveFont(), tmp);
  } finally {
    if (saved === undefined) delete process.env.SCOUT_VIDEO_FONT;
    else process.env.SCOUT_VIDEO_FONT = saved;
    fs.rmSync(tmp, { force: true });
  }
});

test("buildOverlayFilter returns empty graph without a font (plain transcode)", () => {
  const graph = buildOverlayFilter({
    font: "",
    width: 390,
    height: 844,
    durationMs: 6000,
    scenarioName: "Login",
    verdict: "verified",
    timeline: TIMELINE,
    pacing: pacingFor(0.4),
  });
  assert.equal(graph, "");
});

test("buildOverlayFilter bakes title, captions and verdict card", () => {
  const graph = buildOverlayFilter({
    font: "/font.ttf",
    width: 390,
    height: 844,
    durationMs: 6000,
    scenarioName: "Free user hits paywall",
    verdict: "verified",
    timeline: TIMELINE,
    pacing: pacingFor(0.4),
  });
  assert.match(graph, /drawtext/);
  assert.match(graph, /scout preview/);
  assert.match(graph, /VERIFICADO/);
  assert.match(graph, /Free user hits paywall/);
  assert.match(graph, /navegar para \/login/);
  assert.match(graph, /expansion=none/); // % is never interpreted
});

test("buildOverlayFilter strips quotes/backslashes and truncates overflowing titles", () => {
  const long = "A".repeat(120);
  const graph = buildOverlayFilter({
    font: "/font.ttf",
    width: 390,
    height: 844,
    durationMs: 6000,
    scenarioName: `${long} it's "great" \\o/`,
    verdict: "failed",
    timeline: [],
    pacing: pacingFor(0.4),
  });
  assert.ok(!graph.includes("'great'"), "single quotes must be removed");
  assert.ok(!graph.includes("\\o/"), "backslashes must be removed");
  assert.match(graph, /…/); // long title truncated with ellipsis
  assert.match(graph, /FALHOU/);
});

test(
  "generateVideo produces a playable MP4 with overlays (needs ffmpeg)",
  { skip: findFfmpeg() ? false : "ffmpeg not installed" },
  () => {
    const ffmpeg = findFfmpeg()!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-video-"));
    const webm = path.join(dir, "in.webm");
    const make = spawnSync(
      ffmpeg,
      ["-y", "-f", "lavfi", "-i", "color=c=0x223344:s=390x844:d=4", "-c:v", "libvpx", "-an", webm],
      { stdio: "ignore" }
    );
    if (make.status !== 0) return; // libvpx unavailable on this build — nothing to assert

    const out = path.join(dir, "video.mp4");
    const result = generateVideo({
      webmPath: webm,
      outPath: out,
      width: 390,
      height: 844,
      scenarioName: "Login flow",
      verdict: "verified",
      timeline: TIMELINE,
      pacing: pacingFor(0.4),
    });

    assert.equal(result.output, out);
    assert.ok(fs.existsSync(out));
    assert.ok(fs.statSync(out).size > 1000);
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", out],
      { encoding: "utf8" }
    );
    if (probe.status === 0) assert.match(probe.stdout, /h264/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
);
