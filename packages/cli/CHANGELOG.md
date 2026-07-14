# Changelog

## [0.13.0](https://github.com/pcamarajr/scout/compare/scout-v0.12.0...scout-v0.13.0) (2026-07-14)


### Features

* **cli:** seed localStorage/sessionStorage per scenario ([#63](https://github.com/pcamarajr/scout/issues/63)) ([ee3ac93](https://github.com/pcamarajr/scout/commit/ee3ac932a645b896ae3d2efd7d5b33a7f5812802))

## [0.12.0](https://github.com/pcamarajr/scout/compare/scout-v0.11.2...scout-v0.12.0) (2026-07-03)


### Features

* **cli:** add browser_wheel and browser_drag gesture primitives ([#58](https://github.com/pcamarajr/scout/issues/58)) ([fd048fc](https://github.com/pcamarajr/scout/commit/fd048fc886060f3cdb0e2bf11f37330bbcf4fbef))
* **cli:** per-assertion timeout and one-shot presence checks ([#60](https://github.com/pcamarajr/scout/issues/60)) ([fa3fa69](https://github.com/pcamarajr/scout/commit/fa3fa69ccadae461f2f80f959649c7ef5b50bd95))

## [0.11.2](https://github.com/pcamarajr/scout/compare/scout-v0.11.1...scout-v0.11.2) (2026-07-03)


### Bug Fixes

* **cli:** restore scenarioStatus export dropped in 0.11.0 ([#56](https://github.com/pcamarajr/scout/issues/56)) ([c7773ea](https://github.com/pcamarajr/scout/commit/c7773eae1c89937e5940f0d83288385515ba81e9))

## [0.11.1](https://github.com/pcamarajr/scout/compare/scout-v0.11.0...scout-v0.11.1) (2026-06-30)


### Bug Fixes

* **cli:** film demo videos for ephemeral --viewport runs ([#54](https://github.com/pcamarajr/scout/issues/54)) ([3eec430](https://github.com/pcamarajr/scout/commit/3eec430b774771eefe238ad519ad95619d209649))

## [0.11.0](https://github.com/pcamarajr/scout/compare/scout-v0.10.0...scout-v0.11.0) (2026-06-29)


### Features

* **cli:** run scenarios across named viewports ([#51](https://github.com/pcamarajr/scout/issues/51)) ([0893c18](https://github.com/pcamarajr/scout/commit/0893c185451ba925711b3b6bc311bbb92503f547))

## [0.10.0](https://github.com/pcamarajr/scout/compare/scout-v0.9.0...scout-v0.10.0) (2026-06-29)


### Features

* **cli:** let `scout go -s <spec>` run every scenario in a spec ([#49](https://github.com/pcamarajr/scout/issues/49)) ([dab19ca](https://github.com/pcamarajr/scout/commit/dab19ca752763f898fd7cda0815728161c481d79))
* **cli:** scout doctor runtime checks + record-video preflight ([#47](https://github.com/pcamarajr/scout/issues/47)) ([997f71d](https://github.com/pcamarajr/scout/commit/997f71de1ca4e1df21341af2657e88e42aaa5304))
* **cli:** set cookies per scenario and profile before the flow ([#46](https://github.com/pcamarajr/scout/issues/46)) ([9918877](https://github.com/pcamarajr/scout/commit/99188778bf572846456cef0a84cf6fae9f83eff8))
* **cli:** turn --record-video into a polished demo with a synthetic cursor ([#48](https://github.com/pcamarajr/scout/issues/48)) ([10e1598](https://github.com/pcamarajr/scout/commit/10e1598178c0068062dfd0334d49d6b771f5d839))

## [0.9.0](https://github.com/pcamarajr/scout/compare/scout-v0.8.0...scout-v0.9.0) (2026-06-23)


### Features

* **cli:** send custom HTTP headers to reach protected deploys ([#41](https://github.com/pcamarajr/scout/issues/41)) ([6c69c48](https://github.com/pcamarajr/scout/commit/6c69c489f99d23763f202f4db7e811cd03faf72c))

## [0.8.0](https://github.com/pcamarajr/scout/compare/scout-v0.7.1...scout-v0.8.0) (2026-06-21)


### Features

* assert a console log appeared (browser_assert_console_message) ([#29](https://github.com/pcamarajr/scout/issues/29)) ([6e0f649](https://github.com/pcamarajr/scout/commit/6e0f649362c70c0b518f001c4e918735a0e60b75))
* inspect browser console and network with deterministic assertions ([#25](https://github.com/pcamarajr/scout/issues/25)) ([4559094](https://github.com/pcamarajr/scout/commit/4559094f863e2469be2a693c4d82fd00d0d5c8eb))
* multi-tab support — switch to and assert on popups/new tabs ([#28](https://github.com/pcamarajr/scout/issues/28)) ([41e088e](https://github.com/pcamarajr/scout/commit/41e088e522612b8598ea50bd9fbae1490bb23982))
* per-scenario browser permission policy (grant/deny/geolocation) ([#27](https://github.com/pcamarajr/scout/issues/27)) ([74cc1d6](https://github.com/pcamarajr/scout/commit/74cc1d628120c8dca2fec4404a01c2f06c3b6950))


### Bug Fixes

* switchTab picks newest matching tab; reject empty console substrings ([#30](https://github.com/pcamarajr/scout/issues/30)) ([e0966f1](https://github.com/pcamarajr/scout/commit/e0966f146dc3f618fdacaade42a2777e50a68300))

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
