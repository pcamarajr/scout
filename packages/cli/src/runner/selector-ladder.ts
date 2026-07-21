import type { FragileStep, Step, Target } from "../types.js";
import { describeStep } from "./script-runner.js";

/**
 * The selector preference ladder, applied at RECORD time to every interaction
 * step. When a target element is resolved we walk these strategies against the
 * live element, most-stable first, and record the highest rung that *uniquely*
 * matches — instead of silently falling back to a positional CSS path that
 * works during the AI run but breaks later in deterministic replay.
 *
 *   testid → id → role+name → text → css (positional, last resort)
 *
 * The pure parts live here (candidate construction, the auto-generated-id
 * heuristic) so ordering and rejection are unit-testable without a browser; the
 * live uniqueness probing lives in `BrowserSession.resolveTarget`.
 */
export type LadderStrategy = "testid" | "id" | "role" | "text" | "css";

/** Raw signals extracted from a live element, feeding the ladder. */
export interface LadderInfo {
  /** ARIA role (explicit or derived from the tag). */
  role?: string;
  /** Accessible name COMPUTED from the live DOM at record time (never guessed). */
  name?: string;
  /** Positional CSS path — always present, the guaranteed last resort. */
  css: string;
  /** The element's OWN testid attribute value. */
  testId?: string;
  /** Nearest ancestor's testid (within a few hops) — used for clicks only. */
  ancestorTestId?: string;
  /** The element's raw `id` attribute (validated by {@link isStableId}). */
  id?: string;
  /** Trimmed visible text, when short and stable enough for a text anchor. */
  text?: string;
}

/** One ladder rung that produced a usable Target. */
export interface LadderCandidate {
  strategy: LadderStrategy;
  target: Target;
}

/**
 * Rejects ids that look framework-generated / non-deterministic, so we never
 * anchor a recorded selector to an id that changes between renders. Heuristic
 * (documented, deliberately simple):
 *  - any run of 3+ digits (hydration counters, `field-1234`), and
 *  - known auto-id prefixes: Radix (`radix-`), React `useId` (`:r…`, `:R…`),
 *    `react-`, Headless UI (`headlessui-`), MUI (`mui-`).
 * Everything else (hand-authored ids like `login-form`, `email`) is accepted.
 */
const AUTO_ID_RE = /\d{3,}|^radix-|^react-|^headlessui-|^mui-|^:[rR]/;

export function isStableId(id: string | undefined): id is string {
  if (!id) return false;
  const trimmed = id.trim();
  if (!trimmed) return false;
  return !AUTO_ID_RE.test(trimmed);
}

/**
 * A CSS attribute selector for an id — `[id="…"]` with quotes/backslashes
 * escaped. Preferred over `#id` because it needs no CSS.escape and tolerates
 * ids with characters (`.`, `:`) that a `#` selector would misparse.
 */
export function idSelector(id: string): string {
  return `[id="${id.replace(/(["\\])/g, "\\$1")}"]`;
}

/**
 * Builds the ordered ladder of candidate Targets for a live element, most-stable
 * first. Every rung that has the needed signal is included; the live uniqueness
 * check downstream keeps only those that match exactly one element. A positional
 * CSS candidate is ALWAYS appended last so there is always something to record.
 *
 * The element's OWN handles (own testid, id, role+name, text) rank above a
 * borrowed ANCESTOR testid: when the element itself is uniquely identifiable we
 * act on IT, not on a wrapping container. The ancestor testid sits just above
 * the positional CSS path — a stable rescue for a role-less control whose only
 * durable handle lives on a close wrapper (an icon button inside a
 * `<div data-testid>`). `allowAncestorTestId` gates it: on for clicks, off for
 * fill/select where acting on a container instead of the field would be wrong.
 */
export function buildLadderCandidates(
  info: LadderInfo,
  opts: { allowAncestorTestId?: boolean; testIdAttr?: string } = {}
): LadderCandidate[] {
  const attr = opts.testIdAttr ?? "data-testid";
  const out: LadderCandidate[] = [];

  if (info.testId) {
    out.push({ strategy: "testid", target: { testId: info.testId, description: `[${attr}="${info.testId}"]` } });
  }
  if (isStableId(info.id)) {
    out.push({ strategy: "id", target: { css: idSelector(info.id), description: `#${info.id}` } });
  }
  if (info.role && info.name) {
    out.push({
      strategy: "role",
      target: { role: info.role, name: info.name, description: `${info.role} "${info.name}"` },
    });
  }
  if (info.text) {
    out.push({ strategy: "text", target: { text: info.text, description: `text "${info.text}"` } });
  }
  if (opts.allowAncestorTestId && info.ancestorTestId && info.ancestorTestId !== info.testId) {
    out.push({
      strategy: "testid",
      target: { testId: info.ancestorTestId, description: `[${attr}="${info.ancestorTestId}"]` },
    });
  }
  out.push({ strategy: "css", target: { css: info.css, description: info.css } });
  return out;
}

/**
 * Assembles the recorded Target from the ladder candidates that uniquely matched
 * (in ladder order). The first is the primary; the rest become ordered
 * `fallbacks`. When the primary is the positional CSS rung, the target is flagged
 * `fragile`. When NOTHING uniquely matched (a rare mid-run DOM shift), the
 * positional CSS candidate is recorded anyway, flagged fragile — best effort,
 * matching the pre-ladder behavior of always recording a CSS path.
 */
export function assembleTarget(
  candidates: LadderCandidate[],
  unique: LadderCandidate[]
): Target {
  const chosen = unique.length ? unique : [candidates[candidates.length - 1]];
  const [primary, ...rest] = chosen;
  const target: Target = { ...primary.target };
  if (primary.strategy === "css") target.fragile = true;
  const fallbacks = rest.map((c) => c.target);
  if (fallbacks.length) target.fallbacks = fallbacks;
  return target;
}

/** A short strategy label for a target, used in fallback-usage log notes. */
export function describeTargetStrategy(target: Target): string {
  if (target.testId) return `testid "${target.testId}"`;
  if (target.role && target.name) return `role ${target.role} "${target.name}"`;
  if (target.text) return `text "${target.text}"`;
  if (target.css) return `css ${target.css}`;
  return target.description;
}

/**
 * Runs an action against a target's primary selector and, on failure, against
 * each recorded fallback in order until one succeeds — a deterministic retry
 * with NO LLM (so `--no-heal` semantics hold). `onFallback` is notified with a
 * human-readable note when a fallback resolved. If every candidate fails, the
 * PRIMARY's error is thrown (the most relevant one to debug). Pure over a
 * `locate` factory so it is unit-testable without a browser.
 */
export async function runWithFallback<L>(
  target: Target,
  locate: (t: Target) => L,
  act: (loc: L) => Promise<unknown>,
  onFallback?: (note: string) => void
): Promise<void> {
  try {
    await act(locate(target));
  } catch (primaryError) {
    for (const fallback of target.fallbacks ?? []) {
      try {
        await act(locate(fallback));
        onFallback?.(`${describeTargetStrategy(target)} → fallback ${describeTargetStrategy(fallback)}`);
        return;
      } catch {
        // try the next fallback
      }
    }
    throw primaryError;
  }
}

/** The record-time / report warning for one fragile step. */
export function fragileWarning(step: FragileStep): string {
  return `step ${step.step} (${step.description}) recorded with a positional selector — add a data-testid or a unique role/name to make replay robust.`;
}

/**
 * Collects the interaction steps whose recorded selector is a fragile positional
 * CSS path, for surfacing at record time and in the report. Pure over the
 * recorded script; empty when every step has a stable handle.
 */
export function collectFragileSteps(steps: Step[]): FragileStep[] {
  const out: FragileStep[] = [];
  steps.forEach((step, i) => {
    if ("target" in step && step.target.fragile) {
      out.push({ step: i + 1, description: describeStep(step) });
    }
  });
  return out;
}
