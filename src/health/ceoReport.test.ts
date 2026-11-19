import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Suite } from "@playwright/test/reporter";
import { aggregateHealth, compileCategories } from "./aggregate";
import { buildCeoHealthMessage, loadCeoMappings } from "./ceoReport";

describe("CEO health report", () => {
  it("loads starter mappings and lets app rules extend, override, or disable them", () => {
    const defaults = loadCeoMappings();
    const defaultRule = defaults[0];
    const directory = mkdtempSync(join(tmpdir(), "ceo-health-mappings-"));
    const configPath = join(directory, "mappings.json");
    try {
      writeFileSync(configPath, JSON.stringify({ rules: [
        { id: defaultRule.id, impact: "Updated impact for {count} checks." },
        { id: "app-specific", match: ["promo code invalid"], label: "Promo code", impact: "Affected {count} checks.", action: "Refresh the code." },
        { id: defaults[1].id, enabled: false },
      ] }));
      const mappings = loadCeoMappings(configPath);
      expect(mappings.find(rule => rule.id === defaultRule.id)?.impact).toBe("Updated impact for {count} checks.");
      expect(mappings.some(rule => rule.id === "app-specific")).toBe(true);
      expect(mappings.some(rule => rule.id === defaults[1].id)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("groups configured impact and action counts and marks unmatched errors unconfirmed", () => {
    const makeTest = (id: string, error: string, outcome = "unexpected") => ({
      id,
      titlePath: () => ["Booking", id],
      outcome: () => outcome,
      expectedStatus: "passed",
      results: [{
        status: outcome === "unexpected" ? "failed" : "passed",
        annotations: [],
        errors: [{ message: error }],
      }],
    });
    const suite = { allTests: () => [
      makeTest("points-1", "Account has 0 Aeroplan points"),
      makeTest("points-2", "Account has 0 Aeroplan points"),
      makeTest("unknown", "Unexpected validation response: password=PRIVATE_VALUE"),
      makeTest("passed", "", "expected"),
    ] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const mappings = [{
      id: "points", match: ["0 aeroplan points"], label: "Aeroplan points unavailable",
      impact: "Redemption checks affected: {count}.", action: "Top up or replace the test accounts.",
    }];

    const card = JSON.parse(buildCeoHealthMessage(summary, {
      title: "Booking", environment: "QA",
    }, { status: "failed", duration: 7_300, errors: [] }, mappings));
    const text = card.attachments[0].content.body.map((entry: { text: string }) => entry.text).join("\n");

    expect(text).toContain("QA - Booking");
    expect(text).toContain("1 expected; 3 unexpected; 0 flaky; 0 skipped; 4 total");
    expect(text).toContain("Aeroplan points unavailable \\(2\\)");
    expect(text).toContain("Redemption checks affected: 2.");
    expect(text).toContain("Top up or replace the test accounts.");
    expect(text).toContain("Cause unconfirmed");
    expect(text).toContain("Review the detailed test report.");
    expect(text).not.toContain("PRIVATE_VALUE");
  });

  it("keeps configured CEO details within the payload budget", () => {
    const suite = { allTests: () => [0, 1, 2, 3].map(index => ({
      id: `failure-${index}`,
      titlePath: () => ["Booking", `failure-${index}`],
      outcome: () => "unexpected",
      expectedStatus: "passed",
      results: [{ status: "failed", annotations: [], errors: [{ message: `issue-${index}` }] }],
    })) } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const mappings = [0, 1, 2, 3].map(index => ({
      id: `issue-${index}`,
      match: [`issue-${index}`],
      label: `Issue ${index}`,
      impact: "🚀".repeat(200),
      action: "🧭".repeat(200),
    }));
    const body = buildCeoHealthMessage(summary, { maxPayloadBytes: 4096 }, {
      status: "failed", duration: 1000, errors: [],
    }, mappings);

    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(4096);
    expect(body).toContain("issue groups omitted");
  });

  it("uses Playwright expected and unexpected outcome names", () => {
    const suite = { allTests: () => [{
      id: "expected-failure",
      titlePath: () => ["expected failure"],
      outcome: () => "expected",
      expectedStatus: "failed",
      results: [{ status: "failed", annotations: [], errors: [{ message: "Expected failure" }] }],
    }] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const body = buildCeoHealthMessage(summary, {}, { status: "passed", duration: 1000, errors: [] }, []);
    const text = JSON.parse(body).attachments[0].content.body.map((entry: { text: string }) => entry.text).join("\n");

    expect(text).toContain("1 expected; 0 unexpected");
    expect(text).not.toContain("1 passed; 0 failed");
  });

  it("reports signal evidence on passing tests instead of showing an all-clear", () => {
    const suite = { allTests: () => [{
      id: "signal-on-pass",
      titlePath: () => ["signal on pass"],
      outcome: () => "expected",
      expectedStatus: "passed",
      results: [{ status: "passed", annotations: [{ type: "env-signal:sso-denied" }], errors: [] }],
    }] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const body = buildCeoHealthMessage(summary, {}, { status: "passed", duration: 1000, errors: [] }, []);
    const text = JSON.parse(body).attachments[0].content.body.map((entry: { text: string }) => entry.text).join("\n");

    expect(text).toContain("Signal evidence observed");
    expect(text).not.toContain("No failed tests or reported issues.");
  });

  it("matches only prefixed, non-noise signal kinds", () => {
    const suite = { allTests: () => [
      {
        id: "wrong-prefix",
        titlePath: () => ["wrong prefix"],
        outcome: () => "unexpected",
        expectedStatus: "passed",
        results: [{ status: "failed", annotations: [{ type: "env-signal:http-5xx" }], errors: [] }],
      },
      {
        id: "noise",
        titlePath: () => ["noise"],
        outcome: () => "unexpected",
        expectedStatus: "passed",
        results: [{ status: "failed", annotations: [{ type: "signal:ambient" }], errors: [] }],
      },
    ] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories([{ name: "Ambient", kinds: ["ambient"], noise: true }]), "signal:");
    const mappings = [
      { id: "http", match: ["env-signal:http-5xx"], label: "Backend outage", impact: "Outage", action: "Investigate." },
      { id: "ambient", match: ["signal:ambient"], label: "Ambient signal", impact: "Noise", action: "Ignore." },
    ];
    const body = buildCeoHealthMessage(summary, {}, { status: "failed", duration: 1000, errors: [] }, mappings);
    const text = JSON.parse(body).attachments[0].content.body.map((entry: { text: string }) => entry.text).join("\n");

    expect(text).not.toContain("Backend outage");
    expect(text).not.toContain("Ambient signal");
    expect(text.match(/Other issue/g)).toHaveLength(2);
  });

  it("sanitizes configured labels and escapes diagnostic Markdown", () => {
    const suite = { allTests: () => [
      {
        id: "mapped",
        titlePath: () => ["mapped"],
        outcome: () => "unexpected",
        expectedStatus: "passed",
        results: [{ status: "failed", annotations: [], errors: [{ message: "match-rule" }] }],
      },
      {
        id: "unmapped",
        titlePath: () => ["unmapped"],
        outcome: () => "unexpected",
        expectedStatus: "passed",
        results: [{ status: "failed", annotations: [], errors: [{ message: "[Open report](https://example.test)" }] }],
      },
    ] } as unknown as Suite;
    const summary = aggregateHealth(suite, compileCategories());
    const body = buildCeoHealthMessage(summary, {
      sanitizeText: value => value.replace(/private/gi, "masked"),
    }, { status: "failed", duration: 1000, errors: [] }, [{
      id: "mapped", match: ["match-rule"], label: "private [label]", impact: "Impact", action: "Review.",
    }]);
    const text = JSON.parse(body).attachments[0].content.body.map((entry: { text: string }) => entry.text).join("\n");

    expect(text).toContain("masked \\[label\\] \\(1\\)");
    expect(text).toContain("\\[Open report\\]\\(https://example.test\\)");
    expect(text).not.toContain("[Open report](https://example.test)");
    expect(text).not.toContain("private");
  });

  it("counts runner errors hidden by both display and storage caps", () => {
    const summary = aggregateHealth({ allTests: () => [] } as unknown as Suite, compileCategories());
    const body = buildCeoHealthMessage(summary, {}, {
      status: "failed", duration: 1000, errors: Array.from({ length: 20 }, (_, index) => `error-${index}`), errorsOmitted: 3,
    }, []);
    const text = JSON.parse(body).attachments[0].content.body.map((entry: { text: string }) => entry.text).join("\n");

    expect(text).toContain("21 additional runner issues omitted.");
  });

  it("keeps fallback cards within the byte budget when runner errors are large", () => {
    const summary = aggregateHealth({ allTests: () => [] } as unknown as Suite, compileCategories());
    const body = buildCeoHealthMessage(summary, {
      title: "🚀".repeat(160), environment: "🧭".repeat(160), maxPayloadBytes: 4096,
    }, {
      status: "failed", duration: 1000, errors: ["🧨".repeat(300), "🔑".repeat(300)],
    }, []);

    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(4096);
    expect(body).toContain("runner issues omitted");
  });
});
