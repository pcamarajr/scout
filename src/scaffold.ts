import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Onboarding artifacts written by `scout init` so any AI agent in the consuming
 * repo can help a QA team configure Scout and author `.scout.md` scenarios.
 *
 * Three files, two ownership models:
 *   - AGENTS.md (repo root) — SHARED with the user and other tools. Scout owns
 *     only a managed block delimited by the markers below; everything outside
 *     it is left untouched.
 *   - .claude/skills/scout/SKILL.md and .cursor/rules/scout.mdc — Scout-OWNED,
 *     overwritten on every init (init is the upgrade path).
 *
 * Re-running init refreshes all three. `scout.config.json` is never touched here.
 */

export const SCOUT_BLOCK_START = "<!-- scout:start -->";
export const SCOUT_BLOCK_END = "<!-- scout:end -->";

const AGENTS_FILE = "AGENTS.md";
const SKILL_FILE = path.join(".claude", "skills", "scout", "SKILL.md");
const CURSOR_RULE_FILE = path.join(".cursor", "rules", "scout.mdc");

/** Resolve the bundled `templates/` dir, whether running from `src/` or `dist/`. */
export function templatesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here is <pkg>/src or <pkg>/dist → templates sits at <pkg>/templates
  return path.join(here, "..", "templates");
}

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(templatesDir(), name), "utf8");
}

/**
 * Embed `body` inside the scout managed block in `existing` content.
 *
 *  - no existing content        → just the block.
 *  - existing WITH a block       → replace ONLY the block's contents.
 *  - existing WITHOUT a block    → append the block, preserving everything else.
 */
export function applyManagedBlock(existing: string | undefined, body: string): string {
  const block = `${SCOUT_BLOCK_START}\n${body.trim()}\n${SCOUT_BLOCK_END}\n`;

  if (existing === undefined || existing.trim() === "") {
    return block;
  }

  const startIdx = existing.indexOf(SCOUT_BLOCK_START);
  const endIdx = existing.indexOf(SCOUT_BLOCK_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + SCOUT_BLOCK_END.length);
    // Trim a leading newline off `after` so we don't accumulate blank lines.
    return `${before}${block}${after.replace(/^\n/, "")}`;
  }

  // No block yet — append, keeping the user's content and a clean separator.
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${block}`;
}

export interface ScaffoldDeps {
  cwd?: string;
  log?: (message: string) => void;
}

/** Write/refresh AGENTS.md (managed block), the Claude skill, and the Cursor rule. */
export function scaffoldAgentOnboarding(deps: ScaffoldDeps = {}): void {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? ((m: string) => console.log(m));

  // 1. AGENTS.md — managed block, never clobbers surrounding content.
  const agentsPath = path.join(cwd, AGENTS_FILE);
  const body = readTemplate("AGENTS.md");
  const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : undefined;
  const had = existing !== undefined;
  const hadBlock = had && existing!.includes(SCOUT_BLOCK_START);
  fs.writeFileSync(agentsPath, applyManagedBlock(existing, body));
  log(
    hadBlock
      ? `✓ ${AGENTS_FILE} — refreshed the Scout block.`
      : had
        ? `✓ ${AGENTS_FILE} — appended the Scout block (your content kept).`
        : `✓ ${AGENTS_FILE} created.`
  );

  // 2. Claude Code skill — Scout-owned, overwrite.
  const skillPath = path.join(cwd, SKILL_FILE);
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, readTemplate("SKILL.md"));
  log(`✓ ${SKILL_FILE}`);

  // 3. Cursor rule — Scout-owned, overwrite.
  const cursorPath = path.join(cwd, CURSOR_RULE_FILE);
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, readTemplate("scout.mdc"));
  log(`✓ ${CURSOR_RULE_FILE}`);
}
