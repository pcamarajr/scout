import type { Step } from "../types.js";
import type { BrowserSession } from "./browser.js";

export interface ReplayOutcome {
  passed: boolean;
  failedStep?: string;
  failedIndex?: number;
  error?: string;
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
