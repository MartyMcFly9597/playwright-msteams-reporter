# CEO Health Report Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a concise, configurable CEO impact-and-actions card to the optional Playwright health reporter, without reading a JSON artifact.

**Architecture:** Keep `dev` as the default report type and route `ceo` to a separate renderer that consumes the existing `HealthSummary` from live Playwright callbacks. Load package starter rules and optionally merge consumer JSON rules by stable ID; sanitize error text before matching and use an explicitly unconfirmed grouped fallback.

**Tech Stack:** TypeScript, Playwright Reporter API, Jest, Adaptive Cards, Node.js JSON/file APIs.

---

### Task 1: Add CEO mapping and rendering behavior

**Files:**
- Create: `src/health/ceoReport.ts`
- Create: `src/health/ceoReport.test.ts`
- Modify: `src/health/render.ts` only if a shared sanitizer helper is required

**Steps:**
1. Write tests for package defaults, consumer additions, same-ID overrides, disabled rules, literal matching, first-match ownership, sanitized fallback grouping, and a concise Adaptive Card.
2. Run `npx jest src/health/ceoReport.test.ts --runInBand --coverage=false` and verify the missing implementation causes the expected failures.
3. Implement a small mapping loader and deterministic grouping renderer. Match sanitized title/error/signal text; replace `{count}`; cap visible groups; mark fallback causes unconfirmed.
4. Rerun the focused test file and keep sanitization and serialized payload assertions explicit.

### Task 2: Integrate CEO style into HealthReporter

**Files:**
- Modify: `src/healthReporter.ts`
- Modify: `src/healthReporter.test.ts`

**Steps:**
1. Add reporter tests proving `reportType: "ceo"` chooses the CEO card, omitted type retains the current developer card, and multiple instances remain independent.
2. Run focused tests and verify the new dispatch expectation fails before implementation.
3. Add validated `reportType` and `ceoMappingsFile` options; load/merge mappings for CEO mode and pass the existing aggregate to the selected renderer.
4. Run both reporter and CEO renderer tests.

### Task 3: Document consumer configuration and verify package

**Files:**
- Modify: `README.md`
- Modify: `scripts/test-packaged-artifact.cjs` if package-consumer coverage needs extension

**Steps:**
1. Document `dev` default, `ceo` configuration, JSON mapping schema, built-in rule overrides/additions/disabling, and two registrations for both cards.
2. Add a packed-consumer type/runtime assertion for CEO options and config loading if not already covered by unit tests.
3. Run focused tests, the complete Jest suite, `npm run build`, and `npm run test:package`.
4. Review the diff, ensure the existing local `.gitignore` edit is not staged, and run a whitespace check.
