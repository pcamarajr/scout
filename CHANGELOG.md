# Changelog

## [0.7.1](https://github.com/pcamarajr/scout/compare/scout-v0.7.0...scout-v0.7.1) (2026-06-19)


### Bug Fixes

* republish to ship README landing page and docs/ refresh ([#23](https://github.com/pcamarajr/scout/issues/23)) ([24624f9](https://github.com/pcamarajr/scout/commit/24624f957039e28672be200ce2e82d57f4953de9))

## [0.7.0](https://github.com/pcamarajr/scout/compare/scout-v0.6.0...scout-v0.7.0) (2026-06-18)


### Features

* add a Vercel AI SDK engine behind SCOUT_ENGINE, with Anthropic parity ([#17](https://github.com/pcamarajr/scout/issues/17)) ([6f78c65](https://github.com/pcamarajr/scout/commit/6f78c65bdc4ae9f2dd43a77d329c32e15a0d077a))
* provider-aware AI credential preflight and scout doctor ([#16](https://github.com/pcamarajr/scout/issues/16)) ([3448135](https://github.com/pcamarajr/scout/commit/344813545b445a5cc7e26b223e9c2c594171febb))
* wire Google and OpenAI providers on the AI SDK engine ([#21](https://github.com/pcamarajr/scout/issues/21)) ([a769e1d](https://github.com/pcamarajr/scout/commit/a769e1da7e9fb7a0a6437da36931c830493f2a13))

## [0.6.0](https://github.com/pcamarajr/scout/compare/scout-v0.5.0...scout-v0.6.0) (2026-06-18)


### Features

* prompt for base URL on init with --base-url/--yes for non-interactive runs ([#13](https://github.com/pcamarajr/scout/issues/13)) ([7bd3e08](https://github.com/pcamarajr/scout/commit/7bd3e08e76ccd4c14f0b0975f26dfe7b04a456fe))
* scaffold agent onboarding (AGENTS.md, Claude skill, Cursor rule) on init ([#14](https://github.com/pcamarajr/scout/issues/14)) ([92f3684](https://github.com/pcamarajr/scout/commit/92f368451c2586960c67a536b01944bb1bcdee24))


### Bug Fixes

* record a non-paced fallback clip when paced preview replay fails ([#12](https://github.com/pcamarajr/scout/issues/12)) ([65ed7c5](https://github.com/pcamarajr/scout/commit/65ed7c5db1e8b2845074c8f6525da2b4cafb03ac))

## [0.5.0](https://github.com/pcamarajr/scout/compare/scout-v0.4.0...scout-v0.5.0) (2026-06-17)


### Features

* opt-in preview video of verified replays for PR review ([#10](https://github.com/pcamarajr/scout/issues/10)) ([be33f65](https://github.com/pcamarajr/scout/commit/be33f65af6531425c9f267ddcdc8558356920087))
* resolve $ENV:VAR placeholders in browser_navigate URLs ([#9](https://github.com/pcamarajr/scout/issues/9)) ([239733e](https://github.com/pcamarajr/scout/commit/239733e8f5f93c81cfa974ef8edc4ddb3685ee42))

## [0.4.0](https://github.com/pcamarajr/scout/compare/scout-v0.3.0...scout-v0.4.0) (2026-06-14)


### ⚠ BREAKING CHANGES

* the suite is now .scout/specs/**/*.scout.md (one file per feature, YAML frontmatter + `##` scenario sections, mirroring the Playwright Agents test-plan format) instead of a single .scout/scenarios.json.

### Features

* store scenarios as versioned .scout.md files instead of scenarios.json ([#7](https://github.com/pcamarajr/scout/issues/7)) ([6884b62](https://github.com/pcamarajr/scout/commit/6884b62c33933e09c9fe561f0ab2c592700f79d2))

## [0.3.0](https://github.com/pcamarajr/scout/compare/scout-v0.2.0...scout-v0.3.0) (2026-06-12)


### Features

* verdict rescue/retry for AI runs and per-run base-url override ([#5](https://github.com/pcamarajr/scout/issues/5)) ([5d55e1c](https://github.com/pcamarajr/scout/commit/5d55e1c0326fdbbe41819fc92fda0b0f251ba613))

## [0.2.0](https://github.com/pcamarajr/scout/compare/scout-v0.1.0...scout-v0.2.0) (2026-06-11)


### Features

* **report:** machine-readable report (--json/--check) + recorder step pruning ([#1](https://github.com/pcamarajr/scout/issues/1)) ([b933a2c](https://github.com/pcamarajr/scout/commit/b933a2cb0d06dc404e460e3790011dad33fd43bb))
* Scout POC — self-healing browser QA (NL scenarios → AI verify → deterministic replay) ([0cc94a6](https://github.com/pcamarajr/scout/commit/0cc94a6349d06ccbf213518d7afdb9536643a6a5))


### Bug Fixes

* grava navigate relativo quando a URL está sob o baseUrl ([a8fa0e6](https://github.com/pcamarajr/scout/commit/a8fa0e6826a5f175624ea4a654cd5f486853f2a7))
* storageState opcional quando o profile usa o caminho default ([6d02cb6](https://github.com/pcamarajr/scout/commit/6d02cb6dfb3f472aea5081890e9205d2f8b5d2b6))
* unhandled rejection não derruba a suíte ([6e49826](https://github.com/pcamarajr/scout/commit/6e498269e632032b6827a77a1c150db30e3d5188))
