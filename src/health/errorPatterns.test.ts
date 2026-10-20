import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Suite } from "@playwright/test/reporter";
import { aggregateHealth, compileCategories } from "./aggregate";
import type { HealthCategory } from "./aggregate";
import { compileErrorPatterns, defaultErrorPatterns, readErrorPatternsFile } from "./errorPatterns";
import type { ErrorPattern } from "./errorPatterns";
import { buildHealthMessage } from "./render";

const failing = (message: string, annotations: { type: string }[] = []) => ({ allTests: () => [{
  id: "t", titlePath: () => ["t"], outcome: () => "unexpected",
  results: [{ status: "failed", annotations, errors: [{ message }] }],
}] } as unknown as Suite);

function summarize(suite: Suite, patterns: ErrorPattern[] = defaultErrorPatterns, categories?: HealthCategory[]) {
  return aggregateHealth(suite, compileCategories(categories), "env-signal:", compileErrorPatterns(patterns));
}

describe("error patterns", () => {
  it("assesses unreachable-app navigation errors as an environment problem", () => {
    const summary = summarize(failing('page.goto: net::ERR_NAME_NOT_RESOLVED at https://app.acme.example/'));
    expect(summary.assessments.environment).toBe(1);
    expect(summary.assessments.undetermined).toBe(0);
    expect(summary.categories).toEqual([
      { name: "Network", failed: 1, kinds: [{ kind: "App unreachable from this network", tests: 1 }] },
    ]);
    const body = buildHealthMessage(summary, {}, { status: "failed", duration: 0, errors: [] });
    expect(body).toContain("🌐 Network: 1 failed tests");
    expect(body).not.toContain("Developer review");
  });

  it("leaves unmatched failures unchanged", () => {
    const summary = summarize(failing("expect(locator).toBeVisible() failed"));
    expect(summary.assessments.undetermined).toBe(1);
    expect(summary.categories).toEqual([]);
  });

  it("ignores patterns for passing tests", () => {
    const suite = { allTests: () => [{
      id: "p", titlePath: () => ["p"], outcome: () => "expected", expectedStatus: "passed",
      results: [{ status: "passed", annotations: [], errors: [{ message: "net::ERR_NAME_NOT_RESOLVED" }] }],
    }] } as unknown as Suite;
    expect(summarize(suite).categories).toEqual([]);
  });

  it("reads custom patterns from a file and replaces the defaults", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "patterns-")), "patterns.json");
    fs.writeFileSync(file, JSON.stringify({ errorPatterns: [
      { match: "Gateway Timeout", category: "Gateway", assessment: "environment", message: "Gateway timed out" },
    ] }));
    const patterns = readErrorPatternsFile(file);
    expect(summarize(failing("504 Gateway Timeout"), patterns).assessments.environment).toBe(1);
    expect(summarize(failing("net::ERR_NAME_NOT_RESOLVED"), patterns).assessments.environment).toBe(0);
  });

  it("keeps each pattern's category and assessment, even with a shared message or category", () => {
    const patterns: ErrorPattern[] = [
      { match: "alpha", category: "First", assessment: "environment", message: "Unavailable" },
      { match: "beta", category: "Second", assessment: "regression", message: "Unavailable" },
      { match: "gamma", category: "First", assessment: "regression", message: "Other" },
    ];
    const beta = summarize(failing("beta"), patterns);
    expect(beta.assessments.regression).toBe(1);
    expect(beta.categories.map(category => category.name)).toEqual(["Second"]);
    const gamma = summarize(failing("gamma"), patterns);
    expect(gamma.assessments.regression).toBe(1);
    expect(gamma.assessments.environment).toBe(0);
  });

  it("honors a pattern's assessment in a category that shares a signal category name", () => {
    const patterns: ErrorPattern[] = [{ match: "slow", category: "Timeout", assessment: "environment", message: "Slow backend" }];
    expect(summarize(failing("slow"), patterns).assessments.environment).toBe(1);
  });

  it("treats a pattern in a noise category as noise, not failure evidence", () => {
    const categories: HealthCategory[] = [{ name: "Network", kinds: ["net-fail"], noise: true }];
    const summary = summarize(failing("net::ERR_NAME_NOT_RESOLVED"), defaultErrorPatterns, categories);
    expect(summary.categories).toEqual([]);
    expect(summary.noise).toEqual([{ kind: "App unreachable from this network", tests: 1 }]);
    expect(summary.failures[0].categories).toEqual([]);
  });

  it("combines a matched pattern with signal evidence", () => {
    const summary = summarize(failing("net::ERR_NAME_NOT_RESOLVED", [{ type: "env-signal:page-error" }]));
    expect(summary.assessments.mixed).toBe(1);
  });

  it("rejects invalid patterns with a clear error", () => {
    const valid = { match: "x", category: "C", message: "m" };
    expect(() => compileErrorPatterns([{ ...valid, match: "(" }])).toThrow("index 0: match is not a valid regular expression");
    expect(() => compileErrorPatterns([valid, { ...valid, category: "" }])).toThrow("index 1");
    expect(() => compileErrorPatterns([{ ...valid, assessment: "mixed" as never }])).toThrow("assessment");
    expect(() => readErrorPatternsFile(path.join(os.tmpdir(), "missing-patterns.json"))).toThrow("Unable to read");
  });
});
