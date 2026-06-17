# Changelog

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
