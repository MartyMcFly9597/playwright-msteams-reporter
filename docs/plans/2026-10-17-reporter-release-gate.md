# Reporter Release Gate Implementation Plan

> **For GitHub Copilot:** Use the `executing-plans` skill to implement this plan task-by-task.

**Goal:** Validate the npm-packed package across consumer module formats and prove the optional reporter preserves existing reporter behavior and safely submits a second report.

**Architecture:** Add an opt-in package release-gate command and a temporary-consumer harness. Build and pack the package, install the tarball into temp projects, and run browser-free Playwright projects against a local HTTP receiver. The harness uses synthetic fixtures only; supplied report links are broad scenario inspiration and their data is never fetched, copied, or committed. No production runtime changes or new dependencies are planned; `.npmignore` may be tightened to omit compiled test files currently present in the tarball.

**Tech Stack:** Node.js child processes, npm pack/install, Playwright Test CLI, TypeScript compiler, local HTTP server, Jest.

---

### Task 1: Assert tarball contents and package entry points

**Files:**
- Create: `scripts/test-packaged-artifact.cjs`
- Modify: `package.json`
- Modify if required: `.npmignore`

**Step 1: Add a failing tarball-content check**

Pack into a temporary directory and inspect `npm pack --json`. Require root `dist/index.js` and declarations, health reporter and capture subpaths plus declarations, and a legacy deep import used by the existing README. Assert there is no package `exports` map and no compiled `*.test.js` or `*.test.d.ts` in the archive.

**Step 2: Confirm the new release-gate command fails before implementation**

Run: `npm run test:package`

Expected: FAIL because the test script and/or package assertions do not exist.

**Step 3: Add the minimal package script and harness**

Add `test:package` to run build then the standalone CJS harness. The harness creates a temp directory, packs the actual artifact, inspects its file list, installs the tarball without lifecycle scripts, and removes all temporary files in `finally` without masking the primary failure.

**Step 4: Run the package-content check**

Run: `npm run test:package`

Expected: artifact checks pass. If test files are present, exclude only compiled test files through `.npmignore` and rerun.

### Task 2: Smoke-test CommonJS, ESM, TypeScript, and fixture composition

**Files:**
- Modify: `scripts/test-packaged-artifact.cjs`
- Add temporary generated consumer projects/fixtures from the harness

**Step 1: Add failing consumer checks**

Run the packed root reporter and health reporter through CJS and ESM Playwright configs; load the capture helper from a TypeScript consumer and a CommonJS/BDD-style fixture that extends an existing fixture and explicitly requests its lazy capture fixture. Include a legacy deep import to ensure it remains reachable.

**Step 2: Run the focused smoke and confirm unsupported paths fail**

Run: `npm run test:package`

Expected: any broken package entry, default import, declaration, or fixture-composition path fails with the consumer format identified.

**Step 3: Implement only test-harness fixes**

Use isolated temporary consumer directories and local package paths. Do not add a package `exports` map, alter root exports, or add runtime dependencies to make a test pass.

**Step 4: Verify all consumer formats**

Run: `npm run test:package`

Expected: CJS, ESM, TS declarations, JS/BDD fixture composition, and legacy deep imports load from the packed tarball.

### Task 3: Check reporter parity, ordering, and failure isolation

**Files:**
- Modify: `scripts/test-packaged-artifact.cjs`
- Reuse/extend: `src/healthReporter.integration.test.ts` or `src/webhookDelivery.integration.test.ts` only if it avoids duplicating harness logic

**Step 1: Add failing local HTTP acceptance cases**

Assert original-then-health request order; compare the original payload byte-for-byte with optional health reporting enabled and disabled. Cover a stalled first response (headers and body), health second-post rejection, no duplicate stdout, and unchanged test exit status. Use both webhook types via existing payload tests plus at least one packed artifact delivery per type if practical.

**Step 2: Run focused package acceptance tests and confirm failure**

Run: `npm run test:package`

Expected: any duplicate, order, parity, or failure-isolation regression fails locally without a real webhook.

**Step 3: Implement bounded local receiver scenarios**

Use `127.0.0.1`, short explicit timeouts, synthetic secret-like values, and robust close/cleanup logic. Strip inherited Playwright worker/artifact/proxy variables from child environments as existing integration tests do.

**Step 4: Verify order and isolation**

Run: `npm run test:package`

Expected: all requests are local and ordered; reporter transport failures do not change the Playwright test result or leak synthetic secrets.

### Task 4: Check the Playwright floor and representative generic evidence

**Files:**
- Modify: `scripts/test-packaged-artifact.cjs`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Step 1: Add failing compatibility/scenario coverage**

Use the packed package with Playwright 1.45 and the current locked Playwright version. Include missing annotations, explicit environment/busy signal, recovered retry, expected failure, skip/interruption, missing evidence, and large Unicode output. Assert missing annotations degrade to unavailable evidence rather than crashing or inferring cause.

**Step 2: Run and confirm both versions are actually exercised**

Run: `npm run test:package`

Expected: both temp consumers execute the packed reporter and report the observed annotation capability.

**Step 3: Document only verified package boundaries**

Document tested subpaths/module formats, supported annotation behavior, local test command, and generic integration/rollback guidance. State company-app adoption is not validated here. Do not include the supplied report URLs, names, report contents, or company identifiers.

**Step 4: Run final safe verification**

Run: `npm run build`

Run: `npm run test:jest`

Run: `npm run test:package`

Do not run `npm test`; it invokes the Teams-configured demo suite. Expected: all checks pass with local-only HTTP traffic.

**Step 5: Check the final diff**

Run: `git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check`

Confirm changes are limited to release-gate tests/scripts, necessary test packaging filters, and generic docs. No report content or company data may be present.# Reporter Release Gate Implementation Plan

> **For GitHub Copilot:** Use the `executing-plans` skill to implement this plan task-by-task.

**Goal:** Prove the packed npm artifact preserves the original reporter and safely supports the optional health reporter/helper across representative consumer module formats.

**Architecture:** Add one opt-in release-gate command and temporary consumer harness. Build and `npm pack` the repo, install the tarball into isolated temp projects, and run small browser-free Playwright jobs against a local HTTP receiver. Keep production code and runtime dependencies unchanged; no external webhook, private report, or company app is used.

**Tech Stack:** Node.js child processes, npm pack/install, Playwright Test CLI, TypeScript compiler, local HTTP server, Jest.

---

### Task 1: Assert packed artifact contents and CommonJS loading

**Files:**
- Create: `scripts/test-packaged-artifact.cjs`
- Modify: `package.json`
- Test: `src/packagedArtifact.integration.test.ts` or invoke the script through a dedicated Jest wrapper

**Step 1: Add a failing package-content test**

Run `npm pack --json` into a temporary directory and assert the tarball includes `dist/index.js`, its declarations, `dist/healthReporter.js`, `dist/healthCapture.js`, and required declarations, without adding an `exports` map or excluding existing deep imports.

**Step 2: Confirm it fails before the harness exists**

Run: `npm run test:package`

Expected: FAIL because the package smoke harness/script is not implemented.

**Step 3: Add the minimal harness and CJS consumer**

Create isolated temporary project files, install the tarball without running lifecycle scripts, and run a browser-free CJS Playwright config/spec using the packed original reporter and health reporter with a local HTTP receiver. Ensure cleanup runs in `finally` and cannot hide the primary test failure.

**Step 4: Verify the CJS packed consumer**

Run: `npm run test:package`

Expected: the packed root reporter and health subpath load and send local-only requests.

### Task 2: Cover ESM, TypeScript, and JavaScript fixture consumers

**Files:**
- Modify: `scripts/test-packaged-artifact.cjs`
- Create or modify: temporary consumer fixtures generated by the harness

**Step 1: Add failing consumer-format checks**

Exercise an `.mjs` Playwright config, compile a TypeScript consumer importing the reporter/helper declarations, and run a CommonJS fixture that extends rather than replaces an existing fixture. Assert the helper and reporter deep imports load from the installed tarball.

**Step 2: Run and confirm the missing format fails**

Run: `npm run test:package`

Expected: FAIL until each consumer format uses the tarball paths.

**Step 3: Implement the smallest consumer harness changes**

Use absolute paths or local package installation so config-format checks exercise the tarball while all HTTP requests remain on `127.0.0.1`. Do not change the package `exports` field or root entry point.

**Step 4: Verify all consumer formats**

Run: `npm run test:package`

Expected: CJS, ESM, TypeScript, and JavaScript/BDD composition checks pass.

### Task 3: Verify reporter order, payload parity, and failure isolation

**Files:**
- Modify: `scripts/test-packaged-artifact.cjs`
- Reuse/extend: `src/webhookDelivery.integration.test.ts`
- Reuse/extend: `src/healthReporter.integration.test.ts`

**Step 1: Add failing local-receiver acceptance cases**

Assert the original webhook posts first and its payload is byte-identical with or without the optional reporter. Cover both webhook types through existing regression coverage and the packed original path. Simulate stalled first response headers/body and a failed second post; assert the run exit status is unchanged, the next reporter starts after the first settles, no duplicate stdout appears, and no request leaves localhost.

**Step 2: Run the focused integration tests and confirm failure**

Run: `npx --no-install jest --runInBand src/packagedArtifact.integration.test.ts src/webhookDelivery.integration.test.ts src/healthReporter.integration.test.ts`

Expected: newly added packed parity/order cases fail before harness completion.

**Step 3: Implement local HTTP scenarios only**

Use synthetic webhook URLs, bounded test timeouts, and robust server/temp-directory cleanup. Never use configured Teams credentials or external report URLs.

**Step 4: Verify ordering and isolation**

Run the focused integration command above.

Expected: both webhook submissions are sequential; stalls/failures do not duplicate output or change Playwright test status.

### Task 4: Validate the supported Playwright floor and generic evidence scenarios

**Files:**
- Modify: `scripts/test-packaged-artifact.cjs`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Tests: synthetic package-consumer specs

**Step 1: Add failing floor-version and scenario checks**

Run one temporary packed consumer with Playwright 1.45 and one with the current locked Playwright version. Include missing annotations, explicit busy-state annotation, retry recovery, expected failure, skip/interruption, and bounded Unicode payload fixtures. Confirm absent annotation support degrades to unavailable evidence rather than a crash or inferred cause.

**Step 2: Run and confirm the version boundary is exercised**

Run: `npm run test:package`

Expected: both version consumers execute the packed reporters and report their observed annotation capability.

**Step 3: Document verified boundaries and adoption guidance**

Update README/changelog with the tested package entry points, sequential submission guarantee, version limitation, and generic TypeScript/JavaScript usage/rollback steps. Company-app adoption remains explicitly unverified. Do not include supplied report URLs, titles, identifiers, or raw content.

**Step 4: Run final safe verification**

Run: `npm run build`

Run: `npm run test:jest`

Run: `npm run test:package`

Do not run `npm test`; it invokes the Teams-configured demo suite. Expected: all checks pass without external webhooks.

**Step 5: Check the final patch**

Run: `git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check`

Review the diff to ensure only tests, test scripts, and generic documentation changed; no company data or production runtime changes are included.