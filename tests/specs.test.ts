import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addScenario, loadScenarios, slugify, slugToToken } from "../src/specs.js";
import { Store } from "../src/store.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scout-specs-"));
}

function writeSpec(cwd: string, rel: string, content: string): void {
  const file = path.join(cwd, ".scout", "specs", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test("parses frontmatter, multiple scenarios, and per-scenario overrides", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "paywall.scout.md",
    `---
feature: Paywall
profile: anon
tags: [monetization]
---

# Paywall test plan
Some overview prose that should be ignored.

## Free user hits paywall on ep 3
Open ep 3 without login; paywall appears with signup CTA.

## Subscriber bypasses paywall
profile: qa
tags: [smoke]

Logged-in subscriber opens ep 3; plays with no paywall.
`
  );

  const scenarios = loadScenarios(cwd);
  assert.equal(scenarios.length, 2);

  const free = scenarios[0];
  assert.equal(free.slug, "paywall/free-user-hits-paywall-on-ep-3");
  assert.equal(free.name, "Free user hits paywall on ep 3");
  assert.equal(free.feature, "Paywall");
  assert.equal(free.profile, "anon"); // file-level default
  assert.deepEqual(free.tags, ["monetization"]);
  assert.match(free.scenario, /signup CTA/);
  assert.doesNotMatch(free.scenario, /overview prose/); // preamble ignored

  const sub = scenarios[1];
  assert.equal(sub.profile, "qa"); // per-scenario override wins
  assert.deepEqual(sub.tags, ["smoke"]);
  assert.equal(sub.scenario, "Logged-in subscriber opens ep 3; plays with no paywall.");
});

test("nested spec files namespace the file-slug", () => {
  const cwd = tmpProject();
  writeSpec(cwd, "auth/login.scout.md", `## Valid credentials\nUser logs in with valid email + password; lands on /home.\n`);
  const [s] = loadScenarios(cwd);
  assert.equal(s.slug, "auth/login/valid-credentials");
  assert.equal(slugToToken(s.slug), "auth__login__valid-credentials");
});

test("a scenario with no description text is an error", () => {
  const cwd = tmpProject();
  writeSpec(cwd, "empty.scout.md", `## Heading only\n\n## Another\nhas text\n`);
  assert.throws(() => loadScenarios(cwd), /no description text/);
});

test("duplicate headings in one file are rejected", () => {
  const cwd = tmpProject();
  writeSpec(cwd, "dup.scout.md", `## Same\nfirst\n\n## Same\nsecond\n`);
  assert.throws(() => loadScenarios(cwd), /Duplicate scenario/);
});

test("duplicate logical slug across files is rejected", () => {
  const cwd = tmpProject();
  // Two distinct filenames that slugify to the same file-slug → same logical slug.
  writeSpec(cwd, "My Feature.scout.md", `## X\nbody\n`);
  writeSpec(cwd, "my-feature.scout.md", `## X\nbody\n`);
  assert.throws(() => loadScenarios(cwd), /Duplicate scenario slug/);
});

test("distinct nested paths do not collide", () => {
  const cwd = tmpProject();
  writeSpec(cwd, "a.scout.md", `## X\nbody\n`);
  writeSpec(cwd, "dir/a.scout.md", `## X\nbody\n`);
  assert.equal(loadScenarios(cwd).length, 2); // "a/x" vs "dir/a/x"
});

test("addScenario creates the file with frontmatter then appends", () => {
  const cwd = tmpProject();
  const first = addScenario({ feature: "Checkout", name: "Empty cart", scenario: "Cart is empty; shows placeholder.", profile: "anon" }, cwd);
  assert.equal(first.slug, "checkout/empty-cart");
  assert.equal(first.profile, "anon");

  const second = addScenario({ feature: "Checkout", name: "One item", scenario: "Add one item; total updates.", tags: ["smoke"] }, cwd);
  assert.equal(second.slug, "checkout/one-item");

  const all = loadScenarios(cwd);
  assert.equal(all.length, 2);
  assert.equal(all[0].file, path.join(".scout", "specs", "checkout.scout.md"));
});

test("fenced code blocks are not parsed as scenario headings", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "doc.scout.md",
    "---\nfeature: Doc\n---\n\n# Guide\n\n```markdown\n## Not a scenario\nignored\n```\n\n## Real one\nbody text\n"
  );
  const all = loadScenarios(cwd);
  assert.equal(all.length, 1);
  assert.equal(all[0].name, "Real one");
});

test("the init example spec loads as zero scenarios (does not pollute the suite)", () => {
  const cwd = tmpProject();
  new Store(cwd).init();
  assert.equal(loadScenarios(cwd).length, 0);
});

test("migrate slug contract: feature=old-slug yields <old-slug>/<name-slug>", () => {
  // The `scout migrate` command relies on this so it can relocate
  // scripts/<old-slug>.json → scripts/<old-slug>/<name-slug>.json deterministically.
  const cwd = tmpProject();
  const oldSlug = "paywall-free";
  const created = addScenario({ feature: oldSlug, name: "Free user", scenario: "body text" }, cwd);
  assert.equal(slugify(oldSlug), oldSlug); // old slug is slug-stable
  assert.equal(created.slug, `${oldSlug}/free-user`);
});
