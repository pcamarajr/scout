import type { Step } from "../types.js";
import type { BrowserSession } from "./browser.js";
import type { TimelineEntry } from "./video.js";

export interface ReplayOutcome {
  passed: boolean;
  failedStep?: string;
  failedIndex?: number;
  error?: string;
}

const ASSERTION_KINDS = new Set<Step["kind"]>([
  "waitForText",
  "waitForUrl",
  "assertVisible",
  "assertNotVisible",
  "assertUrl",
  "assertNetwork",
  "assertNoConsoleErrors",
  "assertConsoleMessage",
]);

export interface DemoReplayOutcome {
  passed: boolean;
  timeline: TimelineEntry[];
  failedIndex?: number;
  /** Human-readable "step N (description): error" when the replay tripped. */
  failure?: string;
}

/**
 * Replay dedicated to producing the demo video: identical step execution to
 * {@link replaySteps}, but it records each step's wall-clock offset (for burned
 * captions), drives the synthetic cursor to each target and pulses on the
 * action, and dwells after assertions / at the end so a human can read the
 * verified state. It is decoupled from the verdict — this run is never the
 * source of truth, so the pacing pauses and overlay cannot affect a pass/fail
 * decision (the cursor calls are best-effort and swallow their own errors).
 */
export async function replayForDemo(
  session: BrowserSession,
  steps: Step[],
  assertDwellMs: number,
  cursorTravelMs: number,
  endDwellMs: number
): Promise<DemoReplayOutcome> {
  const timeline: TimelineEntry[] = [];
  const epoch = session.videoEpoch ?? Date.now();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // tMs is taken before the cursor travels, so the caption shows during travel.
    const entry: TimelineEntry = {
      label: `${i + 1}/${steps.length} · ${describeStep(step)}`,
      tMs: Date.now() - epoch,
    };
    timeline.push(entry);
    // Demo overlay: move the cursor to the target, let the eye follow, then pulse.
    const center = await session.pointToStep(step, cursorTravelMs);
    if (center) {
      entry.x = center.x;
      entry.y = center.y;
      if (cursorTravelMs) await session.page.waitForTimeout(cursorTravelMs);
      await session.pulseCursor();
    }
    try {
      await session.executeStep(step);
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      return {
        passed: false,
        timeline,
        failedIndex: i,
        failure: `step ${i + 1} (${describeStep(step)}): ${reason}`,
      };
    }
    if (ASSERTION_KINDS.has(step.kind)) await session.page.waitForTimeout(assertDwellMs);
  }
  await session.page.waitForTimeout(endDwellMs); // hold the final frame for the verdict card
  return { passed: true, timeline };
}

const timeoutSuffix = (timeout?: number): string => (timeout ? ` (timeout ${timeout}ms)` : "");

/** Describes a step for reports/errors. */
export function describeStep(step: Step): string {
  switch (step.kind) {
    case "navigate":
      return `navegar para ${step.url}`;
    case "click":
      return `clicar em ${step.target.description}`;
    case "fill":
      return `preencher ${step.target.description}`;
    case "select":
      return `selecionar "${step.value}" em ${step.target.description}`;
    case "press":
      return `pressionar ${step.key}`;
    case "wheel":
      return `scroll (wheel) deltaX=${step.deltaX} deltaY=${step.deltaY}${step.x !== undefined || step.y !== undefined ? ` em (${step.x ?? "centro"}, ${step.y ?? "centro"})` : ""}`;
    case "drag":
      return `arrastar de (${step.fromX}, ${step.fromY}) até (${step.toX}, ${step.toY})`;
    case "waitForText":
      return `esperar texto "${step.text}"${timeoutSuffix(step.timeout)}`;
    case "waitForUrl":
      return `esperar URL conter "${step.pattern}"${timeoutSuffix(step.timeout)}`;
    case "assertVisible":
      return `verificar texto visível "${step.text}"${step.oneShot ? " (one-shot)" : ""}${timeoutSuffix(step.timeout)}`;
    case "assertNotVisible":
      return `verificar texto AUSENTE "${step.text}"${timeoutSuffix(step.timeout)}`;
    case "assertUrl":
      return `verificar URL contém "${step.pattern}"${timeoutSuffix(step.timeout)}`;
    case "assertNetwork":
      return `verificar request ${step.method ?? "ANY"} ${step.urlGlob}${step.status ? ` (status ${step.status})` : ""}${step.responseIncludes?.length ? ` contendo ${step.responseIncludes.join(", ")}` : ""}`;
    case "assertNoConsoleErrors":
      return `verificar ausência de erros no console${step.ignore?.length ? ` (ignorando ${step.ignore.join(", ")})` : ""}`;
    case "assertConsoleMessage":
      return `verificar mensagem de console contendo ${step.includes.map((s) => `"${s}"`).join(" + ")}${step.type ? ` (tipo ${step.type})` : ""}`;
    case "switchTab":
      return `trocar para o tab ${step.urlGlob ? `que casa "${step.urlGlob}"` : "mais recente"}`;
    case "screenshot":
      return `screenshot "${step.label}"`;
  }
}

/**
 * Deterministic replay of a cached script. No LLM involved — this is the
 * cheap path that runs on every CI push.
 */
export async function replaySteps(session: BrowserSession, steps: Step[]): Promise<ReplayOutcome> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      await session.executeStep(step);
    } catch (error) {
      await session.screenshot(`replay-falhou-step-${i + 1}`).catch(() => {});
      return {
        passed: false,
        failedIndex: i,
        failedStep: describeStep(step),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  await session.screenshot("estado-final").catch(() => {});
  return { passed: true };
}
