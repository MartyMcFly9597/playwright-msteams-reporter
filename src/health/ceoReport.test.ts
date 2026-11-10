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
    expect(text).toContain("1 passed; 3 failed; 0 flaky; 0 skipped; 4 total");
    expect(text).toContain("Aeroplan points unavailable (2)");
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
});
