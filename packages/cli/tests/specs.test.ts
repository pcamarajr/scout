import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addScenario, loadScenarios, selectScenarios, slugify, slugToToken } from "../src/specs.js";
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

test("viewports: file-level default inherited; per-section list REPLACES (not merges)", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "nav.scout.md",
    `---
feature: Nav
viewports: [mobile, desktop]
---

## Inherits the file default
Opens the menu.

## Overrides with its own list
viewports: [tablet]

Opens the menu on a tablet.
`
  );
  const [inherits, overrides] = loadScenarios(cwd);
  assert.deepEqual(inherits.viewports, ["mobile", "desktop"]); // file-level default
  assert.deepEqual(overrides.viewports, ["tablet"]); // replaced, not merged with the file list
});

test("viewports: an invalid name fails loud at parse time", () => {
  const cwd = tmpProject();
  writeSpec(cwd, "bad.scout.md", `## X\nviewports: [Mobile XL]\n\nbody.\n`);
  assert.throws(() => loadScenarios(cwd), /Invalid viewport name "Mobile XL"/);
});

test("nested spec files namespace the file-slug", () => {
  const cwd = tmpProject();
  writeSpec(cwd, "auth/login.scout.md", `## Valid credentials\nUser logs in with valid email + password; lands on /home.\n`);
  const [s] = loadScenarios(cwd);
  assert.equal(s.slug, "auth/login/valid-credentials");
  assert.equal(slugToToken(s.slug), "auth__login__valid-credentials");
});

test("selectScenarios: full slug targets one scenario; spec slug targets the whole file", () => {
  const cwd = tmpProject();
  writeSpec(cwd, "auth.scout.md", `## Login success\nlogs in.\n\n## Login failure\nwrong password.\n`);
  writeSpec(cwd, "billing.scout.md", `## Upgrade\nupgrades plan.\n`);
  const all = loadScenarios(cwd);

  // Full slug → single scenario (the existing `scenario/case` form).
  assert.deepEqual(
    selectScenarios(all, "auth/login-success").map((s) => s.slug),
    ["auth/login-success"]
  );
  // Spec slug → every scenario in that file (the new `scenario` form).
  assert.deepEqual(
    selectScenarios(all, "auth").map((s) => s.slug),
    ["auth/login-success", "auth/login-failure"]
  );
  // Heading name still matches.
  assert.deepEqual(
    selectScenarios(all, "Upgrade").map((s) => s.slug),
    ["billing/upgrade"]
  );
  // No match → empty.
  assert.deepEqual(selectScenarios(all, "nope"), []);
});

test("selectScenarios: nested spec dir slug matches its scenarios", () => {
  const cwd = tmpProject();
  writeSpec(cwd, "auth/login.scout.md", `## Valid\nok.\n\n## Invalid\nbad.\n`);
  writeSpec(cwd, "auth/logout.scout.md", `## Bye\nlogs out.\n`);
  const all = loadScenarios(cwd);

  // Directory prefix runs everything under it.
  assert.deepEqual(
    selectScenarios(all, "auth").map((s) => s.slug),
    ["auth/login/valid", "auth/login/invalid", "auth/logout/bye"]
  );
  // A deeper prefix narrows to one file.
  assert.deepEqual(
    selectScenarios(all, "auth/login").map((s) => s.slug),
    ["auth/login/valid", "auth/login/invalid"]
  );
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

test("parses browser permissions from frontmatter and per-scenario overrides", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "store-locator.scout.md",
    `---
feature: Store Locator
denyPermissions: [geolocation]
---

## Manual fallback when location is blocked
Open the store locator and search for Merate.

## Nearby with fixed location
grantPermissions: geolocation
geolocation: 45.69, 9.43

Open the store locator; the nearest store is shown.
`
  );

  const [fallback, nearby] = loadScenarios(cwd);

  // File-level default applies to the first scenario.
  assert.deepEqual(fallback.permissions, { deny: ["geolocation"] });

  // Per-axis merge: the section grants geolocation (with coords); the file's
  // inherited deny of geolocation is overridden because grant wins over deny.
  assert.deepEqual(nearby.permissions, {
    grant: ["geolocation"],
    geolocation: { latitude: 45.69, longitude: 9.43 },
  });
});

test("section override replaces the file-level permission axis", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "perms.scout.md",
    `---
feature: Perms
grantPermissions: [notifications]
---

## Camera instead
grantPermissions: camera

Body text for the scenario.
`
  );
  const [s] = loadScenarios(cwd);
  assert.deepEqual(s.permissions, { grant: ["camera"] });
});

test("rejects an unknown permission name", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "bad.scout.md",
    `---
feature: Bad
---

## Typo
denyPermissions: geolocaton

Body text.
`
  );
  assert.throws(() => loadScenarios(cwd), /Unknown permission "geolocaton"/);
});

test("rejects granting geolocation without coordinates", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "geo.scout.md",
    `---
feature: Geo
---

## No coords
grantPermissions: geolocation

Body text.
`
  );
  assert.throws(() => loadScenarios(cwd), /requires coordinates/);
});

test("supplying coordinates implies granting geolocation", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "geo2.scout.md",
    `---
feature: Geo2
---

## Coords only
geolocation: 10, 20

Body text.
`
  );
  const [s] = loadScenarios(cwd);
  assert.deepEqual(s.permissions, {
    grant: ["geolocation"],
    geolocation: { latitude: 10, longitude: 20 },
  });
});

test("scenarios without permission keys have undefined permissions", () => {
  const cwd = tmpProject();
  writeSpec(cwd, "plain.scout.md", `---\nfeature: Plain\n---\n\n## Nothing\nJust prose.\n`);
  const [s] = loadScenarios(cwd);
  assert.equal(s.permissions, undefined);
});

test("parses cookies: frontmatter object-list + per-section inline override merged by name", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "variants.scout.md",
    `---
feature: Checkout variant
cookies:
  - name: hn_checkout_variant
    value: A
  - name: consent
    value: "yes"
    httpOnly: true
    sameSite: Lax
---

## Default variant from the file
Open checkout; the file-level variant A is in effect.

## Force variant C
cookies: hn_checkout_variant=C

Open checkout; variant C is forced.
`
  );

  const [def, forced] = loadScenarios(cwd);

  // File frontmatter applies to the first scenario, attributes preserved.
  assert.deepEqual(def.cookies, [
    { name: "hn_checkout_variant", value: "A" },
    { name: "consent", value: "yes", httpOnly: true, sameSite: "Lax" },
  ]);

  // Section inline override wins by name; the untouched file cookie survives.
  assert.deepEqual(forced.cookies, [
    { name: "hn_checkout_variant", value: "C" },
    { name: "consent", value: "yes", httpOnly: true, sameSite: "Lax" },
  ]);
});

test("inline cookie override keeps the raw $ENV placeholder (never resolved at parse)", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "token.scout.md",
    `---\nfeature: Token\n---\n\n## Seeds a token cookie\ncookies: session=$ENV:SESSION_TOKEN\n\nBody text.\n`
  );
  const [s] = loadScenarios(cwd);
  assert.deepEqual(s.cookies, [{ name: "session", value: "$ENV:SESSION_TOKEN" }]);
});

test("rejects an unknown cookie field", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "badcookie.scout.md",
    `---\nfeature: Bad\ncookies:\n  - name: x\n    value: y\n    sameSi: Lax\n---\n\n## Typo\nBody text.\n`
  );
  assert.throws(() => loadScenarios(cwd), /Unknown cookie field "sameSi"/);
});

test("rejects an invalid sameSite", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "badsamesite.scout.md",
    `---\nfeature: Bad\ncookies:\n  - name: x\n    value: y\n    sameSite: Whatever\n---\n\n## Bad sameSite\nBody text.\n`
  );
  assert.throws(() => loadScenarios(cwd), /sameSite.*Strict, Lax, None/);
});

test("rejects a malformed inline cookie override", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "badinline.scout.md",
    `---\nfeature: Bad\n---\n\n## No equals\ncookies: justname\n\nBody text.\n`
  );
  assert.throws(() => loadScenarios(cwd), /Expected name=value/);
});

test("scenarios without cookies have undefined cookies", () => {
  const cwd = tmpProject();
  writeSpec(cwd, "nocookies.scout.md", `---\nfeature: Plain\n---\n\n## Nothing\nJust prose.\n`);
  const [s] = loadScenarios(cwd);
  assert.equal(s.cookies, undefined);
});

test("grant wins over an inherited deny for the same permission", () => {
  const cwd = tmpProject();
  writeSpec(
    cwd,
    "conflict.scout.md",
    `---
feature: Conflict
denyPermissions: [notifications, camera]
---

## Grant overrides one denied permission
grantPermissions: notifications

Body text.
`
  );
  const [s] = loadScenarios(cwd);
  // notifications moves to grant; camera stays denied.
  assert.deepEqual(s.permissions, { grant: ["notifications"], deny: ["camera"] });
});
