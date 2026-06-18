import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_FILE } from "../src/config.js";
import {
  SCOUT_BLOCK_END,
  SCOUT_BLOCK_START,
  applyManagedBlock,
  scaffoldAgentOnboarding,
  templatesDir,
} from "../src/scaffold.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scout-scaffold-"));
}

const silent = () => {};
const AGENTS = "AGENTS.md";
const SKILL = path.join(".claude", "skills", "scout", "SKILL.md");
const CURSOR = path.join(".cursor", "rules", "scout.mdc");

function read(cwd: string, rel: string): string {
  return fs.readFileSync(path.join(cwd, rel), "utf8");
}

// ---- applyManagedBlock (pure) ----

test("applyManagedBlock creates the block when there is no existing content", () => {
  const out = applyManagedBlock(undefined, "hello");
  assert.equal(out, `${SCOUT_BLOCK_START}\nhello\n${SCOUT_BLOCK_END}\n`);
});

test("applyManagedBlock replaces only the block, preserving surrounding content", () => {
  const existing = `# My agents file\n\nkeep above\n\n${SCOUT_BLOCK_START}\nOLD BODY\n${SCOUT_BLOCK_END}\n\nkeep below\n`;
  const out = applyManagedBlock(existing, "NEW BODY");
  assert.match(out, /keep above/);
  assert.match(out, /keep below/);
  assert.match(out, /NEW BODY/);
  assert.doesNotMatch(out, /OLD BODY/);
  // Exactly one block.
  assert.equal(out.match(new RegExp(SCOUT_BLOCK_START, "g"))?.length, 1);
});

test("applyManagedBlock appends when content exists without a block", () => {
  const existing = "# Other tool's section\n\nsome rules\n";
  const out = applyManagedBlock(existing, "scout body");
  assert.match(out, /Other tool's section/);
  assert.match(out, /scout body/);
  assert.ok(out.indexOf("Other tool") < out.indexOf(SCOUT_BLOCK_START), "user content stays first");
});

// ---- templates resolve ----

test("bundled templates resolve and are non-empty", () => {
  const dir = templatesDir();
  for (const f of ["AGENTS.md", "SKILL.md", "scout.mdc"]) {
    const content = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(content.trim().length > 0, `${f} should be non-empty`);
  }
});

// ---- scaffoldAgentOnboarding (filesystem) ----

test("scaffold writes all three artifacts on a fresh repo", () => {
  const cwd = tmpProject();
  scaffoldAgentOnboarding({ cwd, log: silent });

  const agents = read(cwd, AGENTS);
  assert.ok(agents.includes(SCOUT_BLOCK_START) && agents.includes(SCOUT_BLOCK_END));
  assert.match(agents, /single source of truth/i);

  const skill = read(cwd, SKILL);
  assert.match(skill, /^---\nname: scout/);
  assert.match(skill, /AGENTS\.md/);

  const cursor = read(cwd, CURSOR);
  assert.match(cursor, /globs:/);
  assert.match(cursor, /\*\*\/\*\.scout\.md/);
  assert.match(cursor, /alwaysApply: false/);
});

test("scaffold replaces the block in place on an AGENTS.md with a stale block", () => {
  const cwd = tmpProject();
  const preface = "# Repo agents\n\nHand-written guidance.\n\n";
  fs.writeFileSync(
    path.join(cwd, AGENTS),
    `${preface}${SCOUT_BLOCK_START}\nstale scout content\n${SCOUT_BLOCK_END}\n\n## Another tool\nkeep me\n`
  );

  scaffoldAgentOnboarding({ cwd, log: silent });
  const agents = read(cwd, AGENTS);

  assert.match(agents, /Hand-written guidance/);
  assert.match(agents, /## Another tool/);
  assert.match(agents, /keep me/);
  assert.doesNotMatch(agents, /stale scout content/);
  assert.match(agents, /single source of truth/i);
  assert.equal(agents.match(new RegExp(SCOUT_BLOCK_START, "g"))?.length, 1, "exactly one block");
});

test("scaffold appends the block to an AGENTS.md that has none, keeping user content", () => {
  const cwd = tmpProject();
  fs.writeFileSync(path.join(cwd, AGENTS), "# Existing\n\nUser content here.\n");

  scaffoldAgentOnboarding({ cwd, log: silent });
  const agents = read(cwd, AGENTS);

  assert.match(agents, /User content here/);
  assert.match(agents, new RegExp(SCOUT_BLOCK_START));
  assert.ok(agents.indexOf("User content here") < agents.indexOf(SCOUT_BLOCK_START));
});

test("scaffold overwrites the Scout-owned skill and cursor rule on re-run", () => {
  const cwd = tmpProject();
  scaffoldAgentOnboarding({ cwd, log: silent });

  // Pollute the owned files; a second run must restore them.
  fs.writeFileSync(path.join(cwd, SKILL), "garbage");
  fs.writeFileSync(path.join(cwd, CURSOR), "garbage");

  scaffoldAgentOnboarding({ cwd, log: silent });
  assert.match(read(cwd, SKILL), /^---\nname: scout/);
  assert.match(read(cwd, CURSOR), /globs:/);
});

test("scaffold never touches scout.config.json", () => {
  const cwd = tmpProject();
  const config = '{\n  "baseUrl": "https://prod.example.com"\n}\n';
  fs.writeFileSync(path.join(cwd, CONFIG_FILE), config);

  scaffoldAgentOnboarding({ cwd, log: silent });
  assert.equal(read(cwd, CONFIG_FILE), config);
});

test("re-running scaffold is idempotent for AGENTS.md (no block duplication, stable content)", () => {
  const cwd = tmpProject();
  scaffoldAgentOnboarding({ cwd, log: silent });
  const first = read(cwd, AGENTS);
  scaffoldAgentOnboarding({ cwd, log: silent });
  const second = read(cwd, AGENTS);
  assert.equal(first, second);
  assert.equal(second.match(new RegExp(SCOUT_BLOCK_START, "g"))?.length, 1);
});
