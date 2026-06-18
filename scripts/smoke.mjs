#!/usr/bin/env node
// Packaged-artifact smoke test.
//
// Validates the REAL published artifact (not the source tree): builds, packs a
// tarball with `npm pack`, installs that tarball into a throwaway project just
// like an end user would, then exercises the installed `scout` bin offline.
//
// Cross-platform, ESM, no external dependencies. Exits non-zero with a clear
// message on the first failed check; exits 0 with a concise summary otherwise.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

/** Run a command, capturing stdout/stderr. Throws on a non-zero exit. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    encoding: "utf8",
    shell: isWindows, // npm/npx are .cmd shims on Windows
    env: { ...process.env, ...opts.env },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
    throw new Error(`\`${cmd} ${args.join(" ")}\` exited ${res.status}\n${out}`);
  }
  return `${res.stdout ?? ""}`;
}

/** Run the installed scout bin and return trimmed combined output; throws on non-zero exit. */
function scout(binPath, args, opts = {}) {
  const res = spawnSync(binPath, args, {
    cwd: opts.cwd ?? repoRoot,
    encoding: "utf8",
    shell: isWindows,
    env: { ...process.env, ...opts.env },
  });
  if (res.error) throw res.error;
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  if (res.status !== 0) {
    throw new Error(`\`scout ${args.join(" ")}\` exited ${res.status}\n${out}`);
  }
  return out;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const expectedVersion = pkg.version;

let tmpDir;
let tarballPath;
const checks = [];

try {
  // 1. Build, then pack the tarball exactly as `npm publish` would.
  console.log("• Building (npm run build)…");
  run("npm", ["run", "build"]);

  console.log("• Packing tarball (npm pack)…");
  const packOut = run("npm", ["pack", "--json"]);
  const packed = JSON.parse(packOut);
  const filename = packed?.[0]?.filename;
  assert(filename, "Could not read tarball filename from `npm pack --json` output.");
  tarballPath = path.resolve(repoRoot, filename);
  assert(fs.existsSync(tarballPath), `Packed tarball not found at ${tarballPath}.`);
  checks.push(`packed ${filename}`);

  // 2. Fresh consumer project in a temp dir; install the tarball like a user.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-smoke-"));
  console.log(`• Installing tarball into a fresh project (${tmpDir})…`);
  run("npm", ["init", "-y"], { cwd: tmpDir });
  run("npm", ["install", tarballPath], { cwd: tmpDir });

  // 3. Resolve the installed bin and exercise it offline.
  const binName = isWindows ? "scout.cmd" : "scout";
  const binPath = path.join(tmpDir, "node_modules", ".bin", binName);
  assert(fs.existsSync(binPath), `Installed scout bin not found at ${binPath}.`);
  checks.push("installed scout bin");

  // scout --version → equals package.json version.
  const versionOut = scout(binPath, ["--version"], { cwd: tmpDir });
  assert(
    versionOut === expectedVersion,
    `scout --version printed "${versionOut}", expected "${expectedVersion}".`
  );
  checks.push(`--version == ${expectedVersion}`);

  // scout --help → lists the core commands.
  const helpOut = scout(binPath, ["--help"], { cwd: tmpDir });
  const coreCommands = ["init", "create", "list", "go", "report"];
  for (const cmd of coreCommands) {
    assert(
      new RegExp(`\\b${cmd}\\b`).test(helpOut),
      `scout --help did not mention the "${cmd}" command.`
    );
  }
  checks.push(`--help lists [${coreCommands.join(", ")}]`);

  // scout init --yes (in a fresh subdir) → scaffolds config + onboarding.
  const projectDir = path.join(tmpDir, "project");
  fs.mkdirSync(projectDir);
  scout(binPath, ["init", "--yes"], { cwd: projectDir });

  const configPath = path.join(projectDir, "scout.config.json");
  assert(fs.existsSync(configPath), "scout init --yes did not create scout.config.json.");
  JSON.parse(fs.readFileSync(configPath, "utf8")); // must be valid JSON
  checks.push("init --yes → scout.config.json (valid JSON)");

  assert(
    fs.existsSync(path.join(projectDir, "AGENTS.md")),
    "scout init --yes did not scaffold AGENTS.md."
  );
  checks.push("init --yes → AGENTS.md scaffolded");

  // scout list → exits 0.
  scout(binPath, ["list"], { cwd: projectDir });
  checks.push("list exits 0");

  console.log("\n✓ Smoke test passed:");
  for (const c of checks) console.log(`  - ${c}`);
  process.exitCode = 0;
} catch (err) {
  console.error("\n✗ Smoke test FAILED:");
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  if (checks.length) {
    console.error("  Passed before failure:");
    for (const c of checks) console.error(`    - ${c}`);
  }
  process.exitCode = 1;
} finally {
  // 4. Clean up the temp project and the tarball.
  try {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  try {
    if (tarballPath && fs.existsSync(tarballPath)) fs.rmSync(tarballPath, { force: true });
  } catch {
    /* best effort */
  }
}
