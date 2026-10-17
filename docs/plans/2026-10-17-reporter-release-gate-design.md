# Reporter Release Gate Design

## Goal

Validate that the optional health reporter and capture helper work from the npm-packed artifact while preserving the original reporter's behavior and remaining easy to sync with upstream.

## Design

Add a test-only packed-package smoke harness. It builds and packs the repository, installs the tarball in a temporary consumer, then runs small synthetic Playwright projects using CommonJS and ESM configurations. TypeScript and CommonJS fixture consumers exercise the published reporter/helper entry points. A local HTTP receiver verifies original-then-health submission, byte-identical original payloads with and without the optional reporter, bounded failure isolation, no duplicate output, and unchanged Playwright test results.

Use only synthetic tests and local endpoints. Existing user-supplied reports may inspire broad scenario categories, but their contents, URLs, identifiers, and schemas are not copied or published. Cover retry recovery, environment annotations, missing annotations, expected failures, skips/interruption, Unicode payload limits, and health-only signaling through sanitized fixtures. Test the declared Playwright 1.45 floor and the current locked Playwright version; document any API-dependent capability boundary. Existing unit tests continue to cover both webhook payload types. Do not change production reporter behavior, add dependencies, or add a restrictive `exports` map.

Company adoption remains unverified by this repository-level gate. Documentation will describe generic integration and rollback steps without claiming either company application was tested.# Reporter Release Gate Design

## Goal

Verify the actual packed reporter artifact can be adopted additively, preserves existing reporter behavior, and submits a second health report safely without relying on private application data.

## Design

Add isolated packaging and consumer smoke tests. Build and pack the project into a temporary directory, then run small synthetic Playwright projects against the packed artifact. Exercise CommonJS and ESM reporter configuration, TypeScript declarations, and a JavaScript fixture module that composes with an existing fixture. Resolve the package through its current deep subpaths without adding an `exports` map or changing root imports.

Use a local HTTP receiver to verify the original report is submitted first and remains byte-identical with and without the optional health reporter. Cover sequential delivery, a stalled first response, and second-delivery failure without changing the test exit status or duplicating stdout. Use deterministic synthetic evidence for large/Unicode payloads, busy-state annotations, missing annotations, retries, expected failures, skips, interruptions, and absent evidence. Report URLs are used only as high-level scenario inspiration; never fetch, copy, or commit report content, company identifiers, or private URLs.

Validate the supported Playwright floor separately from the current development version. At minimum, smoke-test package loading and the helper's missing-annotation behavior at Playwright 1.45 and the current locked version; document any capability boundary that cannot be supported by the available APIs. Test both webhook payload families through existing regression coverage and packed delivery smoke tests, without contacting real Teams endpoints.

Keep changes test-focused and additive. Do not add runtime dependencies, change production reporter behavior, add package exports restrictions, or claim validation against either company application. Document only the repository-level packaging and compatibility result; actual company adoption remains a consumer-owned step.