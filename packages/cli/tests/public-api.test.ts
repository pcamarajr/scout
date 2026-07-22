import assert from "node:assert/strict";
import { test } from "node:test";
import * as scout from "../src/index.js";

/**
 * Guard against accidental breaks of the public entrypoint: dropping a value
 * export fails module load for downstream consumers (`SyntaxError: ... does
 * not provide an export named ...`), so a drop must fail CI here — not a
 * consumer at runtime. Removing a name from this list is a breaking change
 * and needs a major release.
 */
const STABLE_EXPORTS = [
  // config
  "loadConfig",
  // credentials
  "claudeCredentialsPath",
  "detectAiCredentials",
  "inferProvider",
  // engine
  "pruneSteps",
  "runAiWithRetry",
  "runScenario",
  // report
  "buildReport",
  "renderRunReport",
  "renderSummary",
  "runStatus",
  "scenarioStatus",
  // ai-runner
  "describeNoVerdict",
  "relativizeUrl",
  // runner/browser
  "closeBrowsers",
  // specs
  "addScenario",
  "loadScenarios",
  "parseSpec",
  "slugify",
  "slugToToken",
  // store
  "Store",
  // viewports
  "BUILTIN_VIEWPORTS",
  "DEFAULT_VIEWPORT",
  "defaultViewportName",
  "expandScenarios",
  "isValidViewportName",
  "resolveViewport",
  "runKey",
  "runnableViewports",
  "viewportRegistry",
];

test("public entrypoint keeps every stable value export", () => {
  const missing = STABLE_EXPORTS.filter((name) => !(name in scout));
  assert.deepEqual(missing, [], `missing public exports: ${missing.join(", ")}`);
});
