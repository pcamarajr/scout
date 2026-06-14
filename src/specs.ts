import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { SCOUT_DIR } from "./config.js";
import type { Scenario } from "./types.js";

/**
 * Scenario specs live as markdown files under `.scout/specs/**\/*.scout.md`.
 * One file per feature/component; each `## heading` is one scenario. The
 * markdown is the human-authored source of truth — a *pure input* that is
 * never written back to by a run (status/last-run derive from `.scout/runs/`).
 *
 * The format mirrors the Playwright Agents test-plan layout (feature file with
 * scenario sections) and adds YAML frontmatter as a superset for scout-specific
 * config (profile, tags). Per-scenario overrides may follow a heading as
 * `key: value` lines before the prose.
 */

export const SPECS_DIR = "specs";
const SPEC_EXT = ".scout.md";
/** Per-scenario override keys allowed under a heading. */
const OVERRIDE_KEYS = new Set(["profile", "notes", "tags"]);

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/** A logical slug `<file>/<scenario>` → a single filesystem-safe token. */
export function slugToToken(slug: string): string {
  return slug.replace(/\//g, "__");
}

function specsRoot(cwd: string): string {
  return path.join(cwd, SCOUT_DIR, SPECS_DIR);
}

/** All `*.scout.md` under `.scout/specs`, recursively, sorted for stable order. */
function findSpecFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findSpecFiles(full));
    else if (entry.isFile() && entry.name.endsWith(SPEC_EXT)) out.push(full);
  }
  return out.sort();
}

/** `.scout/specs/auth/login.scout.md` → `auth/login` (each segment slugified). */
function fileSlugFromPath(specFile: string, root: string): string {
  const rel = path.relative(root, specFile).replace(new RegExp(`${SPEC_EXT.replace(".", "\\.")}$`), "");
  return rel
    .split(path.sep)
    .map((seg) => slugify(seg))
    .join("/");
}

function parseTags(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    const inner = raw.trim().replace(/^\[|\]$/g, "");
    const parts = inner.split(",").map((t) => t.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }
  return undefined;
}

interface Section {
  name: string;
  bodyLines: string[];
}

/**
 * Split markdown body into `## ` sections (h1/h3+ and preamble are ignored).
 * Fenced code blocks (``` ... ```) are skipped so a documented `## ` inside a
 * fence is not mistaken for a real scenario heading.
 */
function splitSections(content: string): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inFence = false;
  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = inFence ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      cur = { name: m[1].trim(), bodyLines: [] };
      sections.push(cur);
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  return sections;
}

/** Parse a single `.scout.md` file into its scenarios. */
export function parseSpec(specFile: string, root: string, cwd: string): Scenario[] {
  const fileSlug = fileSlugFromPath(specFile, root);
  const raw = fs.readFileSync(specFile, "utf8");
  const { data, content } = matter(raw);

  const fileFeature = typeof data.feature === "string" ? data.feature : path.basename(specFile).replace(SPEC_EXT, "");
  const fileProfile = typeof data.profile === "string" ? data.profile : undefined;
  const fileTags = parseTags(data.tags);
  const relFile = path.relative(cwd, specFile);

  const sections = splitSections(content);
  const scenarios: Scenario[] = [];
  const seen = new Set<string>();

  for (const section of sections) {
    // Consume optional leading `key: value` overrides, then the prose.
    const lines = section.bodyLines;
    let i = 0;
    while (i < lines.length && lines[i].trim() === "") i++;
    const overrides: Record<string, string> = {};
    while (i < lines.length && lines[i].trim() !== "") {
      const m = /^([a-zA-Z]+):\s*(.+)$/.exec(lines[i].trim());
      if (!m || !OVERRIDE_KEYS.has(m[1])) break;
      overrides[m[1]] = m[2].trim();
      i++;
    }
    while (i < lines.length && lines[i].trim() === "") i++;
    const text = lines.slice(i).join("\n").trim();

    if (!text) {
      throw new Error(`Scenario "${section.name}" in ${relFile} has no description text.`);
    }

    const scenarioSlug = slugify(section.name);
    if (seen.has(scenarioSlug)) {
      throw new Error(`Duplicate scenario "${section.name}" (slug "${scenarioSlug}") in ${relFile}.`);
    }
    seen.add(scenarioSlug);

    const tags = parseTags(overrides.tags) ?? fileTags;
    scenarios.push({
      slug: `${fileSlug}/${scenarioSlug}`,
      name: section.name,
      scenario: text,
      feature: fileFeature,
      profile: overrides.profile ?? fileProfile,
      notes: overrides.notes,
      tags,
      file: relFile,
    });
  }

  return scenarios;
}

/** Load every scenario across all spec files, validating slug uniqueness. */
export function loadScenarios(cwd = process.cwd()): Scenario[] {
  const root = specsRoot(cwd);
  const all: Scenario[] = [];
  const bySlug = new Map<string, string>();
  for (const file of findSpecFiles(root)) {
    for (const scenario of parseSpec(file, root, cwd)) {
      const prev = bySlug.get(scenario.slug);
      if (prev) {
        throw new Error(`Duplicate scenario slug "${scenario.slug}" in ${scenario.file} (also in ${prev}).`);
      }
      bySlug.set(scenario.slug, scenario.file);
      all.push(scenario);
    }
  }
  return all;
}

export interface NewScenarioInput {
  feature: string;
  name: string;
  scenario: string;
  profile?: string;
  notes?: string;
  tags?: string[];
}

/** Render a `## ` section (with optional overrides) for appending to a spec. */
function renderSection(input: NewScenarioInput): string {
  const overrides: string[] = [];
  if (input.profile) overrides.push(`profile: ${input.profile}`);
  if (input.notes) overrides.push(`notes: ${input.notes}`);
  if (input.tags?.length) overrides.push(`tags: [${input.tags.join(", ")}]`);
  const head = `## ${input.name}\n`;
  const meta = overrides.length ? overrides.join("\n") + "\n\n" : "";
  return `${head}${meta}${input.scenario.trim()}\n`;
}

/**
 * Append a scenario to `.scout/specs/<feature-slug>.scout.md`, creating the
 * file with frontmatter when it does not exist. Returns the logical slug.
 */
export function addScenario(input: NewScenarioInput, cwd = process.cwd()): Scenario {
  const root = specsRoot(cwd);
  const fileSlug = slugify(input.feature);
  const specFile = path.join(root, `${fileSlug}${SPEC_EXT}`);
  fs.mkdirSync(path.dirname(specFile), { recursive: true });

  const section = renderSection(input);
  if (!fs.existsSync(specFile)) {
    const frontmatter = `---\nfeature: ${input.feature}\n---\n\n`;
    fs.writeFileSync(specFile, frontmatter + section);
  } else {
    const existing = fs.readFileSync(specFile, "utf8").replace(/\s*$/, "");
    fs.writeFileSync(specFile, existing + "\n\n" + section);
  }

  const scenarioSlug = slugify(input.name);
  const slug = `${fileSlug}/${scenarioSlug}`;
  const found = parseSpec(specFile, root, cwd).find((s) => s.slug === slug);
  if (!found) {
    throw new Error(`Failed to round-trip scenario "${input.name}" into ${path.relative(cwd, specFile)}.`);
  }
  return found;
}
