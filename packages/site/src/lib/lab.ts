// Scout — Lab feature catalog + spec loader
//
// The Lab is the live demo surface (plan #435): each feature pairs an
// interactive element you can exercise in the browser with the EXACT
// `.scout.md` scenario CI runs against it — single source, no drift.
//
// SINGLE SOURCE OF TRUTH: the scenarios are NOT duplicated here. They are read
// verbatim, at build time, from the site's own dogfood suite under
// `.scout/specs/lab/*.scout.md` — the same files scout replays against the
// deployed Lab in the F4 pipeline. Rendering the raw file guarantees the spec
// shown on the page can never drift from the spec that runs.
//
// The per-feature prose (eyebrow/title/blurb) is catalog CONTENT, not UI
// chrome, so it lives here as data alongside the docs links — mirroring how
// docs prose lives in the content collection rather than in i18n/en.json.
// UI chrome (nav label, section headings, button labels, aria) stays in
// en.json via tl().

// Raw `.scout.md` bodies, keyed by project-root-absolute path. `?raw` bypasses
// Astro's markdown pipeline so we get the file's exact text — frontmatter and
// all — to render in a code panel.
const rawSpecs = import.meta.glob("/.scout/specs/lab/*.scout.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function specFor(file: string): string {
  const key = `/.scout/specs/lab/${file}.scout.md`;
  const raw = rawSpecs[key];
  if (raw === undefined) {
    throw new Error(
      `Lab spec not found: ${key}. Available: ${Object.keys(rawSpecs).join(", ")}`,
    );
  }
  return raw.trim();
}

/** The interactive surface a feature card mounts. Drives the page-view's switch. */
export type LabSurface =
  | "multiTab"
  | "envForm"
  | "network"
  | "console"
  | "auth";

export interface LabFeature {
  /** Matches the scenario `slug` in verdicts.json (`<file>/<scenario>`). */
  slug: string;
  /** Spec file basename under `.scout/specs/lab/`. */
  file: string;
  /** Which live surface this card renders. */
  surface: LabSurface;
  eyebrow: string;
  title: string;
  blurb: string;
  /** Docs entry slug this feature is documented under. */
  docSlug: string;
  /** Optional in-page anchor on the docs entry. */
  docHash?: string;
  /** The exact `.scout.md`, read from the dogfood suite at build time. */
  spec: string;
}

/**
 * The Lab gallery, in display order. Each entry's `slug` mirrors the logical
 * slug scout derives (`<specs-relative-dir>/<github-slugged-heading>`) and must
 * stay in sync with verdicts.json and the heading in the matching spec file.
 * The specs live under `.scout/specs/lab/`, so the dir segment is `lab/<file>`.
 */
export const LAB_FEATURES: LabFeature[] = [
  {
    slug: "lab/multi-tab/a-new-tab-opens-with-the-report-ready",
    file: "multi-tab",
    surface: "multiTab",
    eyebrow: "Multi-tab follows",
    title: "It follows the click into a new tab",
    blurb:
      "A click opens a booking tool, an OAuth window, a report — and the agent follows. Scout records the tab switch as a deterministic step, then runs every assertion on the active tab.",
    docSlug: "scenarios",
    docHash: "flows-that-open-a-new-tab",
    spec: specFor("multi-tab"),
  },
  {
    slug: "lab/env-form/a-coupon-from-the-environment-applies",
    file: "env-form",
    surface: "envForm",
    eyebrow: "Environment interpolation",
    title: "Secrets stay in the environment",
    blurb:
      "Write $ENV:VAR where a value goes; Scout resolves it from the environment at run time — in form fills and navigation URLs alike. The real value never enters the committed script and never reaches the model.",
    docSlug: "auth",
    docHash: "secrets-env-placeholders",
    spec: specFor("env-form"),
  },
  {
    slug: "lab/network/placing-an-order-fires-the-order-api-cleanly",
    file: "network",
    surface: "network",
    eyebrow: "Network assertions",
    title: "It checks the calls the page makes",
    blurb:
      "Describe the expectation in prose — a POST returns 2xx with an orderId. Scout records a tolerant assertion matched on method, URL pattern, and status class, deliberately ignoring volatile ids so replay stays green.",
    docSlug: "scenarios",
    docHash: "asserting-console-logs--api-calls",
    spec: specFor("network"),
  },
  {
    slug: "lab/console/diagnostics-log-the-calibration-marker",
    file: "console",
    surface: "console",
    eyebrow: "Console assertions",
    title: "It reads the browser console",
    blurb:
      'Assert that a specific log appeared — or that no errors did. "No errors" covers console.error and uncaught exceptions; a positive assertion matches a stable prefix so unrelated console noise never makes it flaky.',
    docSlug: "scenarios",
    docHash: "asserting-console-logs--api-calls",
    spec: specFor("console"),
  },
  {
    slug: "lab/auth/a-signed-in-user-reaches-the-calibration-panel",
    file: "auth",
    surface: "auth",
    eyebrow: "Auth profiles",
    title: "It runs as a signed-in user",
    blurb:
      "Capture a logged-in browser session once per environment, then pick a profile per scenario. Authenticated flows replay from the saved session — no login step re-runs, no credentials in the script.",
    docSlug: "auth",
    spec: specFor("auth"),
  },
];
