import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Verdict } from "../types.js";

/**
 * Demo-video pipeline. The video is sourced from a dedicated, paced replay
 * (never the messy AI run) — a synthetic cursor + click pulse are injected into
 * the page (see demoCursorStub) and captured natively by the recording — then
 * post-processed by ffmpeg into a GitHub-ready MP4 with baked-in step labels and
 * a verdict card. ffmpeg is an *optional* system dependency — when it is missing
 * we keep the raw WebM and warn with an install hint instead of bundling a
 * binary into the base install.
 */

export interface TimelineEntry {
  /** Caption burned onto the frame while this step runs (e.g. "2/5 · clicar em ...") */
  label: string;
  /** Milliseconds from video start (context creation) to the step's execution */
  tMs: number;
  /** Target center (viewport px) the cursor moved to — only for target-bearing steps. */
  x?: number;
  y?: number;
}

export interface VideoPacing {
  /** Playwright slowMo (ms added per action) — slows the replay for human viewing */
  slowMoMs: number;
  /** Extra pause after each assertion so the verified state is readable */
  assertDwellMs: number;
  /**
   * Dwell after the synthetic cursor starts travelling to a target, before the
   * step acts — lets the eye follow cursor → target → click. Zeroed in the
   * non-paced fallback so it mirrors the authoritative run.
   */
  cursorTravelMs: number;
  /** Opening card (scenario name) duration */
  titleCardMs: number;
  /** Closing verdict card duration — also the final-frame dwell it overlays */
  verdictCardMs: number;
}

const BASE_SLOWMO = 200;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Maps the single `videoSpeed` knob (0,1] to concrete pacing. <1 = slower.
 * At 1.0 the replay runs at natural speed; the default 0.35 yields a demo a
 * human can actually follow, with enough cursor-travel dwell to read each move.
 */
export function pacingFor(videoSpeed = 0.35): VideoPacing {
  const speed = clamp(videoSpeed, 0.1, 1);
  return {
    slowMoMs: Math.round(BASE_SLOWMO * (1 / speed - 1)),
    assertDwellMs: Math.round(500 / speed),
    cursorTravelMs: clamp(Math.round(250 / speed), 250, 900),
    titleCardMs: 1500,
    verdictCardMs: 1800,
  };
}

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
];

/** First usable font: SCOUT_VIDEO_FONT override, then common system paths. */
export function resolveFont(): string | undefined {
  const override = process.env.SCOUT_VIDEO_FONT;
  if (override && fs.existsSync(override)) return override;
  return FONT_CANDIDATES.find((f) => fs.existsSync(f));
}

export interface FfmpegDiagnosis {
  ok: boolean;
  /** The binary we probed (FFMPEG_PATH or "ffmpeg"). */
  bin: string;
  /** Why it's unusable, when ok is false. */
  reason?: "missing" | "broken";
  /** Human-readable detail — the spawn error, exit signal, or first stderr line. */
  detail?: string;
}

/**
 * Probes ffmpeg and classifies the outcome. "missing" = not on PATH /
 * FFMPEG_PATH points nowhere (spawn errored). "broken" = the binary exists but
 * won't run — typically aborts (e.g. SIGABRT from a missing shared library on a
 * half-removed Homebrew install). The two need different remediation, so we
 * tell them apart instead of collapsing both to "not found".
 */
export function diagnoseFfmpeg(): FfmpegDiagnosis {
  const bin = process.env.FFMPEG_PATH || "ffmpeg";
  const probe = spawnSync(bin, ["-version"], { encoding: "utf8" });
  if (probe.error) {
    return { ok: false, bin, reason: "missing", detail: probe.error.message };
  }
  if (probe.status === 0) return { ok: true, bin };
  const stderr = (probe.stderr || "").trim();
  const firstLine = stderr.split("\n").find((l) => l.trim().length > 0);
  const detail = probe.signal
    ? `aborted with ${probe.signal}${firstLine ? ` — ${firstLine}` : ""}`
    : firstLine || `exited with status ${probe.status}`;
  return { ok: false, bin, reason: "broken", detail };
}

/** Install/repair hint tailored to a missing vs a broken ffmpeg. */
export function ffmpegRemediation(d: FfmpegDiagnosis): string {
  if (d.reason === "broken") {
    return `ffmpeg is installed (${d.bin}) but won't run: ${d.detail}. Repair it — 'brew reinstall ffmpeg' (macOS), reinstall via your package manager (Linux), or point FFMPEG_PATH at a working binary.`;
  }
  return "ffmpeg not found. Install it — 'brew install ffmpeg' (macOS) / 'apt-get install ffmpeg' (Debian/Ubuntu) — or set FFMPEG_PATH to its location.";
}

/** Resolves the ffmpeg binary (FFMPEG_PATH or PATH), or undefined if absent/broken. */
export function findFfmpeg(): string | undefined {
  const d = diagnoseFfmpeg();
  return d.ok ? d.bin : undefined;
}

function probeDurationMs(ffmpegBin: string, file: string): number | undefined {
  const ffprobe =
    process.env.FFPROBE_PATH ||
    (ffmpegBin.endsWith("ffmpeg") ? ffmpegBin.replace(/ffmpeg$/, "ffprobe") : "ffprobe");
  const r = spawnSync(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" }
  );
  if (r.status === 0) {
    const seconds = parseFloat(r.stdout.trim());
    if (!Number.isNaN(seconds)) return Math.round(seconds * 1000);
  }
  return undefined;
}

const VERDICT_COLOR: Record<Verdict, string> = {
  verified: "0x2ECC71",
  failed: "0xE74C3C",
  partial: "0xF39C12",
  blocked: "0x95A5A6",
};

const VERDICT_LABEL: Record<Verdict, string> = {
  verified: "VERIFICADO",
  failed: "FALHOU",
  partial: "PARCIAL",
  blocked: "BLOQUEADO",
};

/**
 * Sanitizes a value for an ffmpeg `drawtext` field. Strips the quote/backslash
 * that would break out of the `text='…'` wrapper, then escapes `:` — ffmpeg's
 * filter-option separator — which otherwise truncates any caption containing a
 * URL (e.g. a `navigate` step's `https://…`) and fails the whole filtergraph.
 */
function safeText(s: string): string {
  return s
    .replace(/['\\]/g, "")
    .replace(/:/g, "\\:")
    .trim();
}

/** Approx Arial glyph advance as a fraction of font size — for width fitting. */
const GLYPH_RATIO = 0.56;

/**
 * drawtext can't wrap, so we shrink the font to fit `maxWidth`, and if even the
 * minimum size overflows we truncate with an ellipsis. Keeps long scenario
 * names and step labels inside the portrait frame instead of bleeding off-edge.
 */
function fitText(
  value: string,
  maxWidth: number,
  maxSize: number,
  minSize: number
): { text: string; size: number } {
  const len = Math.max(value.length, 1);
  const size = Math.floor(maxWidth / (len * GLYPH_RATIO));
  if (size >= maxSize) return { text: value, size: maxSize };
  if (size >= minSize) return { text: value, size };
  const maxChars = Math.max(4, Math.floor(maxWidth / (minSize * GLYPH_RATIO)) - 1);
  return { text: value.length > maxChars ? value.slice(0, maxChars - 1) + "…" : value, size: minSize };
}

export interface OverlaySpec {
  font: string;
  width: number;
  height: number;
  durationMs: number;
  scenarioName: string;
  verdict: Verdict;
  timeline: TimelineEntry[];
  pacing: VideoPacing;
}

/**
 * Builds the ffmpeg `-vf` filtergraph that bakes the overlays. Drawn in array
 * order (later filters sit on top): step captions first, then the opening
 * card, then the verdict card last so it covers the held final frame.
 * Returns "" when no font is available — caller still transcodes, just plain.
 */
export function buildOverlayFilter(spec: OverlaySpec): string {
  const { font, width, durationMs, pacing } = spec;
  if (!font) return "";
  const dur = durationMs / 1000;
  const titleSec = Math.min(pacing.titleCardMs / 1000, dur * 0.4);
  const verdictStart = Math.max(titleSec, dur - pacing.verdictCardMs / 1000);
  const ff = safeText(font);

  const between = (a: number, b: number) => `enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`;
  const text = (
    value: string,
    opts: { size: number; color: string; y: string; box?: boolean; a: number; b: number }
  ) =>
    [
      `drawtext=fontfile='${ff}'`,
      `text='${safeText(value)}'`,
      `fontcolor=${opts.color}`,
      `fontsize=${opts.size}`,
      opts.box ? "box=1:boxcolor=black@0.55:boxborderw=14" : "",
      "x=(w-text_w)/2",
      `y=${opts.y}`,
      "expansion=none",
      between(opts.a, opts.b),
    ]
      .filter(Boolean)
      .join(":");
  const fullBox = (a: number, b: number, alpha = "0.6") =>
    `drawbox=x=0:y=0:w=iw:h=ih:color=black@${alpha}:t=fill:${between(a, b)}`;

  const filters: string[] = [];

  // Step captions — bounded so a long script can't explode the graph.
  spec.timeline.slice(0, 80).forEach((entry, i) => {
    const a = Math.max(entry.tMs / 1000, titleSec);
    const next = spec.timeline[i + 1];
    const b = next ? next.tMs / 1000 : verdictStart;
    if (a >= b) return;
    const fit = fitText(entry.label, width - 68, 26, 14); // box border eats horizontal room
    filters.push(text(fit.text, { size: fit.size, color: "white", y: "h-text_h-60", box: true, a, b }));
  });

  // Opening card.
  const title = fitText(spec.scenarioName, width - 40, 40, 18);
  filters.push(fullBox(0, titleSec));
  filters.push(text(title.text, { size: title.size, color: "white", y: "(h/2)-70", a: 0, b: titleSec }));
  filters.push(text("scout demo", { size: 22, color: "0xBDC3C7", y: "(h/2)+10", a: 0, b: titleSec }));

  // Closing verdict card.
  const verdict = fitText(VERDICT_LABEL[spec.verdict], width - 40, 52, 24);
  filters.push(fullBox(verdictStart, dur));
  filters.push(
    text(verdict.text, {
      size: verdict.size,
      color: VERDICT_COLOR[spec.verdict],
      y: "(h-text_h)/2",
      a: verdictStart,
      b: dur,
    })
  );

  return filters.join(",");
}

export interface GenerateVideoInput {
  webmPath: string;
  outPath: string;
  width: number;
  height: number;
  scenarioName: string;
  verdict: Verdict;
  timeline: TimelineEntry[];
  pacing: VideoPacing;
}

export interface GenerateVideoResult {
  /** Path to the produced artifact (MP4 on success, WebM fallback otherwise) */
  output?: string;
  warning?: string;
}

/**
 * Transcodes the paced WebM to an H.264 MP4 (GitHub-playable) with baked
 * overlays. On any ffmpeg problem the raw WebM is returned as a fallback so
 * `--record-video` always yields a playable file.
 */
export function generateVideo(input: GenerateVideoInput): GenerateVideoResult {
  const diag = diagnoseFfmpeg();
  if (!diag.ok) {
    return {
      output: input.webmPath,
      warning: `MP4 overlay not generated, kept the raw WebM. ${ffmpegRemediation(diag)}`,
    };
  }
  const ffmpeg = diag.bin;

  const font = resolveFont();
  const durationMs =
    probeDurationMs(ffmpeg, input.webmPath) ??
    (input.timeline.at(-1)?.tMs ?? 0) + input.pacing.verdictCardMs;
  const filter = buildOverlayFilter({
    font: font ?? "",
    width: input.width,
    height: input.height,
    durationMs,
    scenarioName: input.scenarioName,
    verdict: input.verdict,
    timeline: input.timeline,
    pacing: input.pacing,
  });

  const args = [
    "-y",
    "-i",
    input.webmPath,
    ...(filter ? ["-vf", filter] : []),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    input.outPath,
  ];
  const run = spawnSync(ffmpeg, args, { stdio: "ignore" });
  if (run.status !== 0) {
    return {
      output: input.webmPath,
      warning: "ffmpeg falhou ao gerar o MP4 — mantido o WebM cru.",
    };
  }

  return {
    output: input.outPath,
    warning: font
      ? undefined
      : "Nenhuma fonte encontrada para os overlays — MP4 gerado sem legendas. Defina SCOUT_VIDEO_FONT apontando para um .ttf.",
  };
}
