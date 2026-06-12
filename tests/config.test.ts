import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_FILE, loadConfig } from "../src/config.js";

function tmpProject(config?: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-config-"));
  if (config) fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(config));
  return dir;
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("defaults apply when there is no config file", () => {
  withEnv({ SCOUT_BASE_URL: undefined }, () => {
    const config = loadConfig(tmpProject());
    assert.equal(config.baseUrl, "http://localhost:3000");
    assert.equal(config.maxTurns, 40);
  });
});

test("scout.config.json overrides defaults", () => {
  withEnv({ SCOUT_BASE_URL: undefined }, () => {
    const config = loadConfig(tmpProject({ baseUrl: "http://app.test:4000" }));
    assert.equal(config.baseUrl, "http://app.test:4000");
  });
});

test("SCOUT_BASE_URL overrides the config file", () => {
  withEnv({ SCOUT_BASE_URL: "http://env.test:5000" }, () => {
    const config = loadConfig(tmpProject({ baseUrl: "http://app.test:4000" }));
    assert.equal(config.baseUrl, "http://env.test:5000");
  });
});

test("explicit override (--base-url) beats env and config file", () => {
  withEnv({ SCOUT_BASE_URL: "http://env.test:5000" }, () => {
    const config = loadConfig(tmpProject({ baseUrl: "http://app.test:4000" }), {
      baseUrl: "http://flag.test:6000",
    });
    assert.equal(config.baseUrl, "http://flag.test:6000");
  });
});

test("empty override is ignored (falls through to env/config)", () => {
  withEnv({ SCOUT_BASE_URL: undefined }, () => {
    const config = loadConfig(tmpProject({ baseUrl: "http://app.test:4000" }), { baseUrl: undefined });
    assert.equal(config.baseUrl, "http://app.test:4000");
  });
});
