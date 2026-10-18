# Reporter Release Gate Design

## Goal

Validate that the optional health reporter and capture helper work from the npm-packed artifact while preserving the original reporter's behavior and remaining easy to sync with upstream.

## Design

Add a test-only packed-package smoke harness. It builds and packs the repository, installs the tarball in a temporary consumer, then runs small synthetic Playwright projects using CommonJS and ESM configurations. TypeScript and CommonJS fixture consumers exercise the published reporter/helper entry points. A local HTTP receiver verifies original-then-health submission, byte-identical original payloads with and without the optional reporter, bounded failure isolation, no duplicate output, and unchanged Playwright test results.

Use only synthetic tests and local endpoints. Existing user-supplied reports may inspire broad scenario categories, but their contents, URLs, identifiers, and schemas are not copied or published. Cover retry recovery, environment annotations, missing annotations, expected failures, skips/interruption, Unicode payload limits, and health-only signaling through sanitized fixtures. Test the declared Playwright 1.45 floor and the current locked Playwright version; document any API-dependent capability boundary. Existing unit tests continue to cover both webhook payload types. Do not change production reporter behavior, add dependencies, or add a restrictive `exports` map.

Company adoption remains unverified by this repository-level gate. Documentation will describe generic integration and rollback steps without claiming either company application was tested.