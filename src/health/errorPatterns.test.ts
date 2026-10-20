import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Suite } from "@playwright/test/reporter";
import { aggregateHealth, compileCategories, defaultCategories } from "./aggregate";
import { compileErrorPatterns, defaultErrorPatterns, mergePatternCategories, readErrorPatternsFile } from "./errorPatterns";
import { buildHealthMessage } from "./render";

const failing = (message: string) => ({ allTests: () => [{
  id: "t", titlePath: () => ["t"], outcome: () => "unexpected",
  results: [{ status: "failed", annotations: [], errors: [{ message }] }],
}] } as unknown as Suite);

function summarize(suite: Suite, patterns = defaultErrorPatterns) {
  const compiled = compileErrorPatterns(patterns);
  const taxonomy = compileCategories(mergePatternCategories(defaultCategories, compiled.categories));
  return aggregateHealth(suite, taxonomy, "env-signal:", compiled);
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

  it("groups patterns into an existing category of the same name", () => {
    const merged = mergePatternCategories(
      [{ name: "Network", kinds: ["net-fail"], assessment: "environment" }],
      compileErrorPatterns(defaultErrorPatterns).categories,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].kinds).toEqual(["net-fail", "App unreachable from this network"]);
  });

  it("rejects invalid patterns with a clear error", () => {
    const valid = { match: "x", category: "C", message: "m" };
    expect(() => compileErrorPatterns([{ ...valid, match: "(" }])).toThrow("index 0: match is not a valid regular expression");
    expect(() => compileErrorPatterns([valid, { ...valid, category: "" }])).toThrow("index 1");
    expect(() => compileErrorPatterns([{ ...valid, message: "a*b" }])).toThrow("message");
    expect(() => compileErrorPatterns([{ ...valid, assessment: "mixed" as never }])).toThrow("assessment");
    expect(() => readErrorPatternsFile(path.join(os.tmpdir(), "missing-patterns.json"))).toThrow("Unable to read");
  });
});
