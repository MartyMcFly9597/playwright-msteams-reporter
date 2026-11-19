# CEO Health Report Design

## Goal

Add an optional CEO-oriented report style to the health reporter that translates Playwright run results into a concise impact-and-actions summary.

## Existing Behavior

Playwright invokes each reporter with the live suite and run result. The health reporter aggregates those objects directly; the JSON reporter writes a separate artifact independently. The CEO style must use the live reporter callbacks and must not require a JSON file.

## Configuration

Add `reportType: "dev" | "ceo"` to `HealthReporterOptions`, defaulting to `dev` to preserve current behavior. A consumer can register the health reporter once for either style, register it twice to receive both, or omit it to receive neither.

CEO issue mappings are maintained in one JSON file per consumer. The package supplies built-in starter mappings based on common examples. An optional `ceoMappingsFile` points to a consumer JSON file whose rules extend the built-ins or replace a built-in rule with the same stable `id`. A rule can be disabled by ID. Mapping matches are case-insensitive literal substrings against sanitized failure title, error text, and signal kinds; the first matching rule owns a failed test so counts cannot double-count.

A mapping provides a concise issue label, impact sentence, and action. The supported `{count}` placeholder is replaced with the number of unique failed tests assigned to that mapping. Invalid configuration fails early with a generic diagnostic that does not echo file contents.

## CEO Card

The CEO card leads with environment/title and a compact outcome line (passed, failed, flaky, skipped, total, and duration). It then shows the highest-impact mapped groups, each with its count, configured impact, and action. Unmapped failures are grouped by sanitized error text and explicitly labeled as unconfirmed, with a neutral review action. Only a small number of issue groups are shown; omitted groups are noted and aggregate counts remain visible. A configured results link remains available for detail.

The developer report remains unchanged. Both styles use existing sanitization, webhook delivery, success/empty-run gates, and payload-size safeguards.

## Data and Safety

No test errors are sent to an external AI service. Error text is sanitized before rule matching or display. Mapping text and fallback diagnostics use existing health text sanitization and payload limits. The JSON file is optional and is loaded only when the CEO style is configured.

## Validation

Unit tests cover default developer compatibility, CEO outcome counts, configured mapping matches, same-ID override, app-specific rule extension, disabled mappings, first-match ownership, sanitized grouped fallback, unknown causes, invalid config, and bounded issue-group output. Reporter tests verify `reportType` dispatch and independent reporter instances. Full Jest, build, and packaged-artifact tests validate delivery and published file behavior.
