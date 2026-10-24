# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.5.0] - 2026-10-24

- Declare support for Node.js 22 or newer; CI verifies Node.js 22, 24, and 26.
- Improve health-detail credential redaction across raw diagnostics, quoted values, JSON, and serialized strings, with bounded scans. Some heuristic matches are narrower to avoid redacting ordinary prose such as `Token refresh` and `Basic configuration`; sanitization remains defense in depth, not a guarantee that arbitrary diagnostics contain no secrets.
- Correct native ESM default reporter imports and their TypeScript declarations while preserving CommonJS entry points. ESM default imports now resolve directly to the reporter class.

### Behavior changes

- Report failed runs without tests and notify on timed-out or interrupted runs even when no tests failed.
- Invalid `webhookType` values now throw. An option explicitly set to `undefined` retains its default instead of overriding it; check existing configuration for reliance on the old behavior.

- Validate reporter options, retain defaults when an option is `undefined`, and omit invalid or incomplete result links.
- Pin CI actions, use Node.js 24 action runtimes, and stage beta npm releases for approval. The stable release workflow retains staged publishing and receives CI/runtime hardening.
- Correct reporter configuration, supported behavior, and migration guidance.

## [0.4.0] - 2026-10-20

- Health reporter: classify failures by error text. A built-in pattern flags Chromium navigation errors such as `net::ERR_NAME_NOT_RESOLVED` as `Network` / "App unreachable from this network" (environment-suspect) instead of developer review. Custom patterns load from a JSON file via `errorPatternsFile`.

## [0.3.0] - 2026-10-20

- Health card: add emoji headings, run duration formatted as `1h 14m`, colored assessment/signal lines, a green "No failures" line, per-category emojis for the default categories, and a "Developer review" group for failures without actionable signals.

## [0.2.0] - 2026-10-20

- Add stable `healthReporter`, `healthCapture`, and `models` package subpaths with TypeScript declaration mappings, keeping build output paths internal.
- Migration: replace imports from `dist/healthReporter` and `dist/healthCapture` with the stable `healthReporter` and `healthCapture` package subpaths.

## [0.1.0] - 2026-10-19

- Reduce environment-signal capture and health-category matching overhead while keeping correlation storage bounded and category precedence unchanged.
- Skip reading successful webhook response bodies by default and cancel unused bodies within the delivery timeout; keep default success output quiet and failure diagnostics concise, with details available through `debug: true`.
- Initial public release under the `@martymcfly9597/playwright-msteams-reporter` package scope.
- Add an optional `links` array for additional Adaptive Card buttons and default the failure-link text to `View failed tests`.
- Add an optional application-neutral test-run health reporter at `@martymcfly9597/playwright-msteams-reporter/dist/healthReporter`; it posts a separate bounded Adaptive Card after the original report when run evidence warrants it.
- Bound webhook requests and response-body reads with `webhookTimeoutMs` (default 10 seconds); report redacted transport failures without changing test outcomes or retrying delivery.
- Resolve omitted or explicitly `undefined` webhook destinations from `MSTEAMS_WEBHOOK_URL` or a custom `webhookUrlEnv` without modifying reporter configuration; an explicit empty URL disables delivery. Config expressions evaluating to `undefined` now use this fallback.
- Redact configured webhook URLs and their canonical URL forms from reporter logs without changing delivery.
- Require `debug: true` for diagnostic dumps; `NODE_ENV=development` alone no longer enables them.
- Add an optional `@martymcfly9597/playwright-msteams-reporter/dist/healthCapture` fixture helper for bounded, sanitized browser evidence and consumer-owned environment-signal policies; existing reporters and fixture exports remain unchanged.
- Add `npm run test:package` to verify packed CJS/ESM/TypeScript consumers, local-only sequential delivery, and the Playwright 1.45/current compatibility boundary.

## [0.0.13]

- [#21](https://github.com/playwright-community/playwright-msteams-reporter/issues/21): Added the `mentionAuthors` option to mention commit/PR authors using Playwright's git metadata
- [#23](https://github.com/playwright-community/playwright-msteams-reporter/issues/23): Added the `enableDuration` option to show the test run duration in the report
- [#24](https://github.com/playwright-community/playwright-msteams-reporter/issues/24): Added the `reportOnEmpty` option to control whether to report when no tests are found
- [#25](https://github.com/playwright-community/playwright-msteams-reporter/issues/25): Removed the webhook URL validation as it keeps changing format

## [0.0.12]

- [#18](https://github.com/playwright-community/playwright-msteams-reporter/issues/18): Fix issue in MS Teams webhook URL validation

## [0.0.11]

- [#15](https://github.com/playwright-community/playwright-msteams-reporter/pull/15): New option `shouldRun` to control when to report based on suite values

## [0.0.10]

- [#10](https://github.com/playwright-community/playwright-msteams-reporter/issues/10): Update to the `linkToResultsUrl` and `linkUrlOnFailure` options to support a function that returns the URL

## [0.0.9]

- [#7](https://github.com/playwright-community/playwright-msteams-reporter/issues/7): Fix for Power Automate webhook URL validation

## [0.0.8]

- [#4](https://github.com/playwright-community/playwright-msteams-reporter/issues/4): Added support for flaky tests
- [#5](https://github.com/playwright-community/playwright-msteams-reporter/issues/5): Added the `enableEmoji` setting to show an emoji based on the test status

## [0.0.7]

- Included the type definition files
- Updated project information
- [#2](https://github.com/playwright-community/playwright-msteams-reporter/issues/2): Added the `linkUrlOnFailure` and `linkTextOnFailure` options
- [#3](https://github.com/playwright-community/playwright-msteams-reporter/issues/3): Sending duplicate results to the webhook

## [0.0.6]

- Set the default value for the `webhookType` option to `powerautomate`.

## [0.0.5]

- The reporter now supports Microsoft Teams incoming webhooks and Power Automate webhooks. You can configure this in the `webhookType` option.

## [0.0.4]

- Added Microsoft Teams incoming webhook URL validation
- Added Jest tests

## [0.0.3]

- Added `debug` option to show the options that are used, plus the payload that is sent to the Microsoft Teams webhook.

## [0.0.2]

- Update readme with more information on how to use the configuration options.

## [0.0.1]

- Initial release of the `playwright-msteams-reporter`.
