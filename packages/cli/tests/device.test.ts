import assert from "node:assert/strict";
import { test } from "node:test";
import {
  effectiveViewportSize,
  isEmptyDevice,
  isKnownDevice,
  mergeDevice,
  parseDeviceBlock,
  parseInlineDevice,
  resolveDeviceOptions,
  validateDevice,
} from "../src/device.js";
import type { ResolvedViewport } from "../src/viewports.js";

// isKnownDevice mirrors Playwright's `devices` registry — the source of truth
// for what a scenario may name.

test("isKnownDevice recognizes shipped device descriptors and rejects the rest", () => {
  assert.ok(isKnownDevice("iPhone 14"));
  assert.ok(isKnownDevice("Pixel 7"));
  assert.ok(!isKnownDevice("Nokia 3310"));
  // guards against prototype keys leaking in as "known" devices
  assert.ok(!isKnownDevice("toString"));
  assert.ok(!isKnownDevice("constructor"));
});

// validateDevice is the curated fail-loud parser for the YAML block form.

test("validateDevice accepts a known device with individual overrides", () => {
  const d = validateDevice(
    { device: "iPhone 14", userAgent: "custom UA", viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    "ctx"
  );
  assert.deepEqual(d, {
    device: "iPhone 14",
    userAgent: "custom UA",
    viewport: { width: 320, height: 640 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
});

test("validateDevice allows overrides without a named device", () => {
  const d = validateDevice({ userAgent: "only UA" }, "ctx");
  assert.deepEqual(d, { userAgent: "only UA" });
});

test("validateDevice fails loud on an unknown device name", () => {
  assert.throws(
    () => validateDevice({ device: "Nokia 3310" }, "ctx"),
    /Unknown Playwright device "Nokia 3310"/
  );
});

test("validateDevice rejects an unknown field", () => {
  assert.throws(() => validateDevice({ devcie: "iPhone 14" }, "ctx"), /Unknown device field "devcie"/);
});

test("validateDevice rejects a bad shape and bad field types", () => {
  assert.throws(() => validateDevice([], "ctx"), /expected an object/);
  assert.throws(() => validateDevice({ userAgent: 42 }, "ctx"), /"userAgent" .* must be a non-empty string/);
  assert.throws(() => validateDevice({ isMobile: "yes" }, "ctx"), /"isMobile" .* must be a boolean/);
  assert.throws(() => validateDevice({ deviceScaleFactor: 0 }, "ctx"), /"deviceScaleFactor" .* must be a positive number/);
  assert.throws(() => validateDevice({ viewport: { width: 320 } }, "ctx"), /"viewport.height" .* must be a positive number/);
  assert.throws(() => validateDevice({ viewport: { width: -1, height: 640 } }, "ctx"), /"viewport.width" .* must be a positive number/);
});

// parseDeviceBlock drops empty objects so a merge/emptiness check stays clean.

test("parseDeviceBlock returns undefined for absent or empty blocks", () => {
  assert.equal(parseDeviceBlock(undefined, "ctx"), undefined);
  assert.equal(parseDeviceBlock(null, "ctx"), undefined);
  assert.equal(parseDeviceBlock({}, "ctx"), undefined);
});

// parseInlineDevice: the per-`##` override names a device only.

test("parseInlineDevice parses a bare device name", () => {
  assert.deepEqual(parseInlineDevice("iPhone 14", "ctx"), { device: "iPhone 14" });
  assert.deepEqual(parseInlineDevice("  Pixel 7  ", "ctx"), { device: "Pixel 7" });
});

test("parseInlineDevice fails loud on empty or unknown device", () => {
  assert.throws(() => parseInlineDevice("   ", "ctx"), /Empty "device" override/);
  assert.throws(() => parseInlineDevice("Nokia 3310", "ctx"), /Unknown Playwright device "Nokia 3310"/);
});

// mergeDevice: override wins per field; viewport replaced wholesale.

test("mergeDevice lets the override win per field, keeping the base's other fields", () => {
  const base = { device: "iPhone 13", userAgent: "base UA", isMobile: true };
  const override = { device: "iPhone 14" };
  assert.deepEqual(mergeDevice(base, override), {
    device: "iPhone 14", // override wins
    userAgent: "base UA", // inherited from base
    isMobile: true, // inherited from base
  });
});

test("mergeDevice handles one-sided and empty inputs", () => {
  assert.equal(mergeDevice(undefined, undefined), undefined);
  assert.deepEqual(mergeDevice({ device: "iPhone 14" }, undefined), { device: "iPhone 14" });
  assert.deepEqual(mergeDevice(undefined, { userAgent: "x" }), { userAgent: "x" });
});

test("isEmptyDevice is true only when nothing is set", () => {
  assert.ok(isEmptyDevice(undefined));
  assert.ok(isEmptyDevice({}));
  assert.ok(!isEmptyDevice({ userAgent: "x" }));
  assert.ok(!isEmptyDevice({ isMobile: false })); // an explicit false still counts as set
});

// resolveDeviceOptions expands the preset, then explicit fields win.

test("resolveDeviceOptions expands a named device into context options", () => {
  const opts = resolveDeviceOptions({ device: "iPhone 14" });
  assert.deepEqual(opts.viewport, { width: 390, height: 664 });
  assert.equal(opts.isMobile, true);
  assert.equal(opts.hasTouch, true);
  assert.match(opts.userAgent ?? "", /iPhone/);
});

test("resolveDeviceOptions lets explicit fields win over the preset", () => {
  const opts = resolveDeviceOptions({
    device: "iPhone 14",
    userAgent: "override UA",
    viewport: { width: 320, height: 480 },
  });
  assert.equal(opts.userAgent, "override UA"); // explicit wins
  assert.deepEqual(opts.viewport, { width: 320, height: 480 }); // explicit wins
  assert.equal(opts.isMobile, true); // inherited from the preset
});

test("resolveDeviceOptions works with overrides and no named device", () => {
  const opts = resolveDeviceOptions({ userAgent: "only UA" });
  assert.equal(opts.userAgent, "only UA");
  assert.equal(opts.viewport, undefined);
  assert.equal(opts.isMobile, undefined);
});

// effectiveViewportSize: device viewport wins, else the named viewport's size.

const vp = (over: Partial<ResolvedViewport> = {}): ResolvedViewport => ({
  name: "mobile",
  width: 390,
  height: 844,
  ...over,
});

test("effectiveViewportSize prefers the device viewport, falling back to the named viewport", () => {
  assert.deepEqual(effectiveViewportSize(vp(), undefined), { width: 390, height: 844 });
  // a named device pins its own size
  assert.deepEqual(effectiveViewportSize(vp(), { device: "iPhone 14" }), { width: 390, height: 664 });
  // an explicit viewport override wins over everything
  assert.deepEqual(
    effectiveViewportSize(vp(), { device: "iPhone 14", viewport: { width: 320, height: 480 } }),
    { width: 320, height: 480 }
  );
  // a device with only a UA override keeps the named viewport's size
  assert.deepEqual(effectiveViewportSize(vp(), { userAgent: "x" }), { width: 390, height: 844 });
});
