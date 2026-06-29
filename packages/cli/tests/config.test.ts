import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_FILE, loadConfig, parseHeadersEnv, resolveCookies, type ScoutConfig } from "../src/config.js";
import type { Scenario } from "../src/types.js";

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

test("recordVideo defaults off; SCOUT_RECORD_VIDEO and --record-video enable it", () => {
  withEnv({ SCOUT_RECORD_VIDEO: undefined }, () => {
    assert.equal(loadConfig(tmpProject()).recordVideo, false);
    assert.equal(loadConfig(tmpProject(), { recordVideo: true }).recordVideo, true);
  });
  withEnv({ SCOUT_RECORD_VIDEO: "1" }, () => {
    assert.equal(loadConfig(tmpProject()).recordVideo, true);
  });
});

test("videoSpeed defaults to 0.4 and is overridable via config file", () => {
  assert.equal(loadConfig(tmpProject()).videoSpeed, 0.4);
  assert.equal(loadConfig(tmpProject({ videoSpeed: 1 })).videoSpeed, 1);
});

test("headers default to undefined; config file sets them", () => {
  withEnv({ SCOUT_EXTRA_HEADERS: undefined }, () => {
    assert.equal(loadConfig(tmpProject()).headers, undefined);
    assert.deepEqual(loadConfig(tmpProject({ headers: { "x-vercel-protection-bypass": "s3cret" } })).headers, {
      "x-vercel-protection-bypass": "s3cret",
    });
  });
});

test("SCOUT_EXTRA_HEADERS merges over (and wins against) the config file", () => {
  withEnv({ SCOUT_EXTRA_HEADERS: '{"x-vercel-protection-bypass":"from-env","x-extra":"e"}' }, () => {
    const config = loadConfig(tmpProject({ headers: { "x-vercel-protection-bypass": "from-file", "x-keep": "k" } }));
    assert.deepEqual(config.headers, {
      "x-vercel-protection-bypass": "from-env", // env wins
      "x-keep": "k", // file-only header preserved
      "x-extra": "e", // env-only header added
    });
  });
});

test("parseHeadersEnv accepts an object of strings and rejects malformed input", () => {
  assert.deepEqual(parseHeadersEnv('{"a":"1","b":"2"}'), { a: "1", b: "2" });
  assert.deepEqual(parseHeadersEnv("{}"), {});
  assert.throws(() => parseHeadersEnv("not json"), /must be a JSON object/);
  assert.throws(() => parseHeadersEnv('["a","b"]'), /must be a JSON object/);
  assert.throws(() => parseHeadersEnv('{"a":1}'), /must be a string/);
});

function scenarioWith(over: Partial<Scenario>): Scenario {
  return { slug: "f/s", name: "s", scenario: "x", feature: "f", file: "f.scout.md", ...over };
}

function configWith(profiles: ScoutConfig["profiles"]): ScoutConfig {
  return { baseUrl: "http://x", model: "m", headless: true, maxTurns: 40, profiles };
}

test("resolveCookies merges profile cookies (base) under scenario cookies (by name)", () => {
  const config = configWith({
    qa: { cookies: [{ name: "consent", value: "yes" }, { name: "v", value: "A" }] },
  });
  const scenario = scenarioWith({ profile: "qa", cookies: [{ name: "v", value: "C" }] });
  // Scenario's `v` wins; profile's `consent` is inherited.
  assert.deepEqual(resolveCookies(scenario, config), [
    { name: "consent", value: "yes" },
    { name: "v", value: "C" },
  ]);
});

test("resolveCookies returns undefined when neither profile nor scenario declare cookies", () => {
  const config = configWith({ qa: {} });
  assert.equal(resolveCookies(scenarioWith({ profile: "qa" }), config), undefined);
  assert.equal(resolveCookies(scenarioWith({}), config), undefined);
});

test("resolveCookies uses scenario cookies when there is no profile", () => {
  const config = configWith({});
  const scenario = scenarioWith({ cookies: [{ name: "v", value: "C" }] });
  assert.deepEqual(resolveCookies(scenario, config), [{ name: "v", value: "C" }]);
});

test("resolveCookies validates profile cookies and rejects a bad sameSite", () => {
  const config = configWith({
    qa: { cookies: [{ name: "v", value: "A", sameSite: "Nope" } as never] },
  });
  assert.throws(() => resolveCookies(scenarioWith({ profile: "qa" }), config), /sameSite/);
});
