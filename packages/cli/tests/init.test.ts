import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_FILE } from "../src/config.js";
import { DEFAULT_BASE_URL, runInit } from "../src/init.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scout-init-"));
}

function readConfig(cwd: string): { baseUrl: string } & Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(cwd, CONFIG_FILE), "utf8"));
}

const silent = () => {};

test("init scaffolds .scout/ and a config with the default base URL when --yes", async () => {
  const cwd = tmpProject();
  await runInit({ yes: true }, { cwd, log: silent });
  assert.ok(fs.existsSync(path.join(cwd, ".scout", "specs")));
  assert.equal(readConfig(cwd).baseUrl, DEFAULT_BASE_URL);
});

test("--base-url wins (no prompt is consulted)", async () => {
  const cwd = tmpProject();
  let prompted = false;
  await runInit(
    { baseUrl: "https://staging.example.com" },
    {
      cwd,
      log: silent,
      resolveBaseUrl: async () => {
        prompted = true;
        return "http://should-not-be-used";
      },
    }
  );
  assert.equal(prompted, false, "the prompt must be skipped when --base-url is given");
  assert.equal(readConfig(cwd).baseUrl, "https://staging.example.com");
});

test("interactive prompt result is written to the config", async () => {
  const cwd = tmpProject();
  await runInit({}, { cwd, log: silent, resolveBaseUrl: async () => "http://localhost:4321" });
  assert.equal(readConfig(cwd).baseUrl, "http://localhost:4321");
});

test("non-TTY / --yes falls back to the default silently", async () => {
  const cwd = tmpProject();
  // No resolveBaseUrl injected and --yes set → must not prompt, must use default.
  await runInit({ yes: true }, { cwd, log: silent });
  assert.equal(readConfig(cwd).baseUrl, DEFAULT_BASE_URL);
});

test("an existing scout.config.json is never overwritten and the prompt is skipped", async () => {
  const cwd = tmpProject();
  const existing = '{\n  "baseUrl": "https://prod.example.com",\n  "secretToken": "keep-me"\n}\n';
  fs.writeFileSync(path.join(cwd, CONFIG_FILE), existing);

  let prompted = false;
  await runInit(
    { baseUrl: "https://clobber.example.com" },
    {
      cwd,
      log: silent,
      resolveBaseUrl: async () => {
        prompted = true;
        return "http://nope";
      },
    }
  );

  assert.equal(prompted, false, "no prompt when config already exists");
  assert.equal(fs.readFileSync(path.join(cwd, CONFIG_FILE), "utf8"), existing, "config left byte-for-byte intact");
  // .scout/ is still (re-)initialized even though the config is untouched.
  assert.ok(fs.existsSync(path.join(cwd, ".scout", "specs")));
});
