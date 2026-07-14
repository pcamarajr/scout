import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isEmptyStorage,
  mergeStorage,
  parseInlineStorage,
  parseStorageBlock,
  validateStorage,
} from "../src/storage.js";

// --- validateStorage: curated, fail-loud ---

test("validateStorage accepts local/session/remove and normalizes remove dupes", () => {
  const s = validateStorage(
    { local: { a: "1" }, session: { b: "2" }, remove: ["x", "x", "y"] },
    "ctx"
  );
  assert.deepEqual(s, { local: { a: "1" }, session: { b: "2" }, remove: ["x", "y"] });
});

test("validateStorage rejects an unknown field", () => {
  assert.throws(() => validateStorage({ locals: { a: "1" } }, "ctx"), /Unknown storage field "locals"/);
});

test("validateStorage rejects a non-object storage", () => {
  assert.throws(() => validateStorage(["a"], "ctx"), /expected an object/);
});

test("validateStorage rejects a non-string value in local", () => {
  assert.throws(() => validateStorage({ local: { a: 3 } }, "ctx"), /"local\.a".*must be a string/);
});

test("validateStorage rejects a remove that is not a list of strings", () => {
  assert.throws(() => validateStorage({ remove: "x" }, "ctx"), /"remove".*list of non-empty string keys/);
  assert.throws(() => validateStorage({ remove: [""] }, "ctx"), /"remove".*list of non-empty string keys/);
});

// --- parseStorageBlock: frontmatter object ---

test("parseStorageBlock returns undefined when absent", () => {
  assert.equal(parseStorageBlock(undefined, "ctx"), undefined);
  assert.equal(parseStorageBlock(null, "ctx"), undefined);
});

test("parseStorageBlock keeps a raw $ENV placeholder (resolved only at launch)", () => {
  const s = parseStorageBlock({ local: { token: "$ENV:APP_TOKEN" } }, "ctx");
  assert.deepEqual(s, { local: { token: "$ENV:APP_TOKEN" } });
});

// --- parseInlineStorage: per-## override line ---

test("parseInlineStorage parses local./session./remove tokens", () => {
  const s = parseInlineStorage(
    "local.hn_app_open_count=3, session.flag=on, remove=hn_pwa_prompt_dismissed",
    "ctx"
  );
  assert.deepEqual(s, {
    local: { hn_app_open_count: "3" },
    session: { flag: "on" },
    remove: ["hn_pwa_prompt_dismissed"],
  });
});

test("parseInlineStorage drops empty namespaces", () => {
  const s = parseInlineStorage("remove=x", "ctx");
  assert.deepEqual(s, { remove: ["x"] });
  assert.equal("local" in s, false);
  assert.equal("session" in s, false);
});

test("parseInlineStorage rejects a token without a recognized prefix", () => {
  assert.throws(() => parseInlineStorage("hn_app_open_count=3", "ctx"), /Expected local\.key=value/);
});

test("parseInlineStorage rejects a token with no equals", () => {
  assert.throws(() => parseInlineStorage("local.foo", "ctx"), /Expected local\.key=value/);
});

test("parseInlineStorage rejects an empty override", () => {
  assert.throws(() => parseInlineStorage("   ", "ctx"), /Empty "storage" override/);
});

// --- mergeStorage: override wins per key per namespace; remove concatenates ---

test("mergeStorage: override wins per key per namespace, remove concatenates + dedupes", () => {
  const base = { local: { a: "1", b: "2" }, session: { s: "x" }, remove: ["k1"] };
  const over = { local: { b: "9", c: "3" }, remove: ["k1", "k2"] };
  assert.deepEqual(mergeStorage(base, over), {
    local: { a: "1", b: "9", c: "3" },
    session: { s: "x" },
    remove: ["k1", "k2"],
  });
});

test("mergeStorage of two empties yields an empty object", () => {
  assert.deepEqual(mergeStorage({}, {}), {});
});

// --- isEmptyStorage ---

test("isEmptyStorage is true for undefined and for a fully-empty object", () => {
  assert.equal(isEmptyStorage(undefined), true);
  assert.equal(isEmptyStorage({}), true);
  assert.equal(isEmptyStorage({ local: {}, session: {}, remove: [] }), true);
  assert.equal(isEmptyStorage({ local: { a: "1" } }), false);
  assert.equal(isEmptyStorage({ remove: ["x"] }), false);
});
