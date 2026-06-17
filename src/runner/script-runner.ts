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
]);

export interface PreviewReplayOutcome {
  passed: boolean;
  timeline: TimelineEntry[];
  failedIndex?: number;
}

/**
 * Replay dedicated to producing the preview video: identical step execution to
 * {@link replaySteps}, but it records each step's wall-clock offset (for burned
 * captions) and dwells after assertions / at the end so a human can read the
 * verified state. It is decoupled from the verdict — this run is never the
 * source of truth, so the pacing pauses cannot affect a pass/fail decision.
 */
export async function replayForVideo(
  session: BrowserSession,
  steps: Step[],
  assertDwellMs: number,
  endDwellMs: number
): Promise<PreviewReplayOutcome> {
  const timeline: TimelineEntry[] = [];
  const epoch = session.videoEpoch ?? Date.now();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    timeline.push({ label: `${i + 1}/${steps.length} · ${describeStep(step)}`, tMs: Date.now() - epoch });
    try {
      await session.executeStep(step);
    } catch {
      return { passed: false, timeline, failedIndex: i };
    }
    if (ASSERTION_KINDS.has(step.kind)) await session.page.waitForTimeout(assertDwellMs);
  }
  await session.page.waitForTimeout(endDwellMs); // hold the final frame for the verdict card
  return { passed: true, timeline };
}

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
    case "waitForText":
      return `esperar texto "${step.text}"`;
    case "waitForUrl":
      return `esperar URL conter "${step.pattern}"`;
    case "assertVisible":
      return `verificar texto visível "${step.text}"`;
    case "assertNotVisible":
      return `verificar texto AUSENTE "${step.text}"`;
    case "assertUrl":
      return `verificar URL contém "${step.pattern}"`;
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
