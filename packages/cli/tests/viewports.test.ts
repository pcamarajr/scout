import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScoutConfig } from "../src/config.js";
import type { Scenario } from "../src/types.js";
import {
  DEFAULT_VIEWPORT,
  defaultViewportName,
  expandScenarios,
  isValidViewportName,
  resolveViewport,
  runnableViewports,
} from "../src/viewports.js";

const cfg = (over: Partial<ScoutConfig> = {}): ScoutConfig => ({
  baseUrl: "http://x",
  model: "m",
  headless: true,
  maxTurns: 40,
  profiles: {},
  ...over,
});

const scn = (over: Partial<Scenario>): Scenario => ({
  slug: "f/s",
  name: "s",
  scenario: "...",
  feature: "f",
  file: "f.scout.md",
  ...over,
});

test("built-in mobile emulates iPhone 13 but pins the canonical 390×844", () => {
  const vp = resolveViewport("mobile", cfg());
  assert.equal(vp.name, "mobile");
  assert.deepEqual({ w: vp.width, h: vp.height }, { w: 390, h: 844 });
  assert.equal(vp.isMobile, true);
  assert.equal(vp.hasTouch, true);
  assert.equal(vp.deviceScaleFactor, 3); // from the iPhone 13 preset
});

test("built-in desktop is a pure viewport (no mobile emulation)", () => {
  const vp = resolveViewport("desktop", cfg());
  assert.deepEqual({ w: vp.width, h: vp.height }, { w: 1280, h: 800 });
  assert.equal(vp.isMobile, undefined);
  assert.equal(vp.hasTouch, undefined);
  assert.equal(vp.userAgent, undefined);
});

test("a device preset composes with explicit field overrides", () => {
  const config = cfg({ viewports: { phone: { device: "iPhone 13", width: 414 } } });
  const vp = resolveViewport("phone", config);
  assert.equal(vp.width, 414); // explicit override wins
  assert.equal(vp.height, 664); // inherited from the iPhone 13 preset
  assert.equal(vp.hasTouch, true); // inherited from the preset
});

test("config viewports override a built-in of the same name", () => {
  const vp = resolveViewport("desktop", cfg({ viewports: { desktop: { width: 1920, height: 1080 } } }));
  assert.deepEqual({ w: vp.width, h: vp.height }, { w: 1920, h: 1080 });
});

test("resolveViewport fails loud on an unknown name, unknown device, or missing dimensions", () => {
  assert.throws(() => resolveViewport("phablet", cfg()), /Unknown viewport "phablet"/);
  assert.throws(
    () => resolveViewport("x", cfg({ viewports: { x: { device: "Nokia 3310" } } })),
    /unknown Playwright device "Nokia 3310"/
  );
  assert.throws(
    () => resolveViewport("x", cfg({ viewports: { x: { isMobile: true } } })),
    /needs explicit width and height/
  );
});

test("defaultViewportName is the built-in, overridable by config", () => {
  assert.equal(defaultViewportName(cfg()), DEFAULT_VIEWPORT);
  assert.equal(defaultViewportName(cfg()), "mobile");
  assert.equal(defaultViewportName(cfg({ defaultViewport: "desktop" })), "desktop");
});

test("runnableViewports: override beats the scenario list beats the default", () => {
  const config = cfg({ defaultViewport: "tablet" });
  assert.deepEqual(runnableViewports(scn({}), config), ["tablet"]); // none declared → default
  assert.deepEqual(runnableViewports(scn({ viewports: ["mobile", "desktop"] }), config), ["mobile", "desktop"]);
  // the override forces a single viewport, ignoring the scenario's declaration
  assert.deepEqual(runnableViewports(scn({ viewports: ["mobile"] }), config, "desktop"), ["desktop"]);
});

test("expandScenarios fans each scenario out into its viewport units", () => {
  const units = expandScenarios(
    [scn({ slug: "a/x" }), scn({ slug: "b/y", viewports: ["mobile", "desktop"] })],
    cfg()
  );
  assert.deepEqual(
    units.map((u) => `${u.scenario.slug}@${u.viewport}`),
    ["a/x@mobile", "b/y@mobile", "b/y@desktop"]
  );
});

test("isValidViewportName accepts the safe charset only", () => {
  assert.ok(isValidViewportName("mobile-xl"));
  assert.ok(!isValidViewportName("iPhone 13"));
  assert.ok(!isValidViewportName("a/b"));
  assert.ok(!isValidViewportName("a@b"));
});
