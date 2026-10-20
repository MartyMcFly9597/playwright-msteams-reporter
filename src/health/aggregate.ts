import type { Suite, TestCase, TestResult } from "@playwright/test/reporter";
import { matchErrorPatterns } from "./errorPatterns";
import type { CompiledErrorPatterns } from "./errorPatterns";

export type Assessment = "environment" | "regression" | "mixed" | "undetermined";

/** Maps signal kinds to a best-effort evidence category in the health report. */
export interface HealthCategory {
  /** User-facing category name. Names must be unique; `Other signals` is reserved. */
  name: string;
  /** Signal kind patterns. `*` matches any sequence; matching is case-sensitive. */
  kinds: string[];
  /** Treat matched signals as ambient context rather than failure evidence. */
  noise?: boolean;
  /** Assessment assigned to failures with a matching signal. Defaults to undetermined. */
  assessment?: Exclude<Assessment, "mixed">;
}
interface CompiledCategory { category: HealthCategory; patterns: string[]; index: number }

export const defaultCategories: HealthCategory[] = [
  { name: "Authentication", kinds: ["sso-*", "http-auth", "auth-*"], assessment: "environment" },
  { name: "Backend and network", kinds: ["http-5xx", "net-fail"], assessment: "environment" },
  { name: "Timeout", kinds: ["test-timeout"], assessment: "undetermined" },
  { name: "Application errors", kinds: ["page-error", "console-error"], assessment: "undetermined" },
];
const other: HealthCategory = { name: "Other signals", kinds: [], assessment: "undetermined" };
const compare = (left: string, right: string) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export function compileCategories(categories: HealthCategory[] = defaultCategories) {
  if (!Array.isArray(categories) || categories.length > 100) throw new Error("Invalid health categories");
  const names = new Set<string>();
  const exactMatches = new Map<string, CompiledCategory>();
  const wildcardMatches: { pattern: string; entry: CompiledCategory }[] = [];
  categories.forEach((category, index) => {
    if (!category || typeof category.name !== "string" || !category.name.trim() ||
        category.name.length > 120 || category.name === other.name || names.has(category.name) ||
        !Array.isArray(category.kinds) || category.kinds.length === 0 || category.kinds.length > 100 ||
        (category.noise !== undefined && typeof category.noise !== "boolean") ||
        (category.assessment !== undefined && !["environment", "regression", "undetermined"].includes(category.assessment)) ||
        (category.noise === true && category.assessment !== undefined)) {
      throw new Error("Invalid health category configuration");
    }
    names.add(category.name);
    const patterns = category.kinds.map(pattern => {
      if (typeof pattern !== "string" || !pattern || pattern.length > 200) throw new Error("Invalid health kind pattern");
      return pattern.replace(/\*+/g, "*");
    });
    const entry = { category: { ...category, kinds: [...category.kinds] }, patterns, index };
    for (const pattern of patterns) {
      if (pattern.includes("*")) wildcardMatches.push({ pattern, entry });
      else if (!exactMatches.has(pattern)) exactMatches.set(pattern, entry);
    }
  });
  const resolutions = new Map<string, HealthCategory>();
  return {
    forKind(kind: string): HealthCategory {
      const cached = resolutions.get(kind);
      if (cached) return cached;
      const exact = exactMatches.get(kind);
      let match: HealthCategory | undefined;
      for (const candidate of wildcardMatches) {
        if (exact && candidate.entry.index > exact.index) break;
        if (matchesKind(candidate.pattern, kind)) {
          match = candidate.entry.category;
          break;
        }
      }
      const category = match ?? exact?.category ?? other;
      resolutions.set(kind, category);
      return category;
    },
  };
}

function matchesKind(pattern: string, kind: string): boolean {
  let patternIndex = 0;
  let kindIndex = 0;
  let starIndex = -1;
  let retryIndex = -1;
  while (kindIndex < kind.length) {
    if (pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      retryIndex = kindIndex;
      patternIndex += 1;
    } else if (pattern[patternIndex] === kind[kindIndex]) {
      patternIndex += 1;
      kindIndex += 1;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      retryIndex += 1;
      kindIndex = retryIndex;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

export interface HealthFailure {
  test: TestCase;
  result?: TestResult;
  assessment: Assessment;
  categories: string[];
}
export interface HealthSummary {
  outcomes: { expected: number; unexpected: number; flaky: number; skipped: number };
  assessments: Record<Assessment, number>;
  categories: { name: string; failed: number; kinds: { kind: string; tests: number }[] }[];
  noise: { kind: string; tests: number }[];
  failures: HealthFailure[];
  unavailable: number;
  passedWithSignals: number;
  recoveredWithSignals: number;
  flakyWithFinalSignals: number;
  flakyFinalKinds: { kind: string; tests: number }[];
  previousAttemptsWithSignals: number;
}

interface CategoryGroup {
  tests: Set<TestCase>;
  kinds: Map<string, number>;
}

interface AggregationState {
  summary: HealthSummary;
  taxonomy: ReturnType<typeof compileCategories>;
  annotationPrefix: string;
  errorPatterns?: CompiledErrorPatterns;
  groups: Map<string, CategoryGroup>;
  noise: Map<string, number>;
  flakyFinalKinds: Map<string, number>;
}

function kindsFor(result: TestResult | undefined, prefix: string): string[] | undefined {
  if (!result || result.status === "skipped" || result.status === "interrupted" || !Array.isArray(result.annotations)) return undefined;
  return [...new Set(result.annotations
    .filter(annotation => annotation && typeof annotation.type === "string" && annotation.type.startsWith(prefix) && annotation.type.length > prefix.length)
    .map(annotation => annotation.type.slice(prefix.length)))].sort(compare);
}

function assess(categories: HealthCategory[]): Assessment {
  const assessments = new Set(categories.map(category => category.assessment ?? "undetermined"));
  if (assessments.size > 1) return "mixed";
  if (assessments.has("environment")) return "environment";
  if (assessments.has("regression")) return "regression";
  return "undetermined";
}

function recordNoise(kinds: string[], taxonomy: AggregationState["taxonomy"], noise: Map<string, number>): void {
  for (const kind of kinds) {
    if (taxonomy.forKind(kind).noise) noise.set(kind, (noise.get(kind) ?? 0) + 1);
  }
}

function recordUnexpected(test: TestCase, result: TestResult | undefined, signalKinds: string[], state: AggregationState): void {
  const error = result?.errors?.[0];
  const patternKinds = state.errorPatterns ? matchErrorPatterns(error?.message ?? error?.value, state.errorPatterns) : [];
  const kinds = [...new Set([...signalKinds, ...patternKinds])].sort(compare);
  const categories = kinds.map(kind => state.taxonomy.forKind(kind));
  const assessment = assess(categories);
  state.summary.assessments[assessment] += 1;
  state.summary.failures.push({ test, result, assessment, categories: [...new Set(categories.map(category => category.name))].sort(compare) });
  for (const kind of kinds) {
    const name = state.taxonomy.forKind(kind).name;
    const group = state.groups.get(name) ?? { tests: new Set<TestCase>(), kinds: new Map<string, number>() };
    group.tests.add(test);
    group.kinds.set(kind, (group.kinds.get(kind) ?? 0) + 1);
    state.groups.set(name, group);
  }
}

function recordTest(test: TestCase, state: AggregationState): void {
  const { summary, taxonomy, annotationPrefix, noise } = state;
  const outcome = test.outcome();
  summary.outcomes[outcome] += 1;
  const results = test.results;
  const result = results.at(-1);
  const kinds = kindsFor(result, annotationPrefix);
  if (outcome !== "skipped" && kinds === undefined) summary.unavailable += 1;
  const currentKinds = kinds ?? [];
  const realKinds = currentKinds.filter(kind => !taxonomy.forKind(kind).noise);
  recordNoise(currentKinds, taxonomy, noise);
  const historical = results.slice(0, -1).some(attempt =>
    (kindsFor(attempt, annotationPrefix) ?? []).some(kind => !taxonomy.forKind(kind).noise));
  if (historical) summary.previousAttemptsWithSignals += 1;
  const finalAttemptExpected = result?.status === test.expectedStatus &&
    result.status !== "skipped" && result.status !== "interrupted";
  if (outcome === "flaky" && finalAttemptExpected && (historical || realKinds.length > 0)) summary.recoveredWithSignals += 1;
  if (outcome === "flaky" && !finalAttemptExpected && realKinds.length > 0) {
    summary.flakyWithFinalSignals += 1;
    for (const kind of realKinds) state.flakyFinalKinds.set(kind, (state.flakyFinalKinds.get(kind) ?? 0) + 1);
  }
  if (result?.status === "passed" && outcome === "expected" && realKinds.length) summary.passedWithSignals += 1;
  if (outcome === "unexpected") recordUnexpected(test, result, realKinds, state);
}

function finalizeGroups(state: AggregationState): void {
  const { summary, groups, noise } = state;
  summary.categories = [...groups].sort(([left], [right]) => compare(left, right)).map(([name, group]) => ({
    name, failed: group.tests.size,
    kinds: [...group.kinds].sort(([left], [right]) => compare(left, right)).map(([kind, tests]) => ({ kind, tests })),
  }));
  summary.noise = [...noise].sort(([left], [right]) => compare(left, right)).map(([kind, tests]) => ({ kind, tests }));
  summary.flakyFinalKinds = [...state.flakyFinalKinds]
    .sort(([left], [right]) => compare(left, right))
    .map(([kind, tests]) => ({ kind, tests }));
  summary.failures.sort((left, right) => compare(left.test.id, right.test.id));
}

export function aggregateHealth(
  suite: Suite,
  taxonomy: ReturnType<typeof compileCategories>,
  annotationPrefix = "env-signal:",
  errorPatterns?: CompiledErrorPatterns
): HealthSummary {
  const summary: HealthSummary = {
    outcomes: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
    assessments: { environment: 0, regression: 0, mixed: 0, undetermined: 0 },
    categories: [], noise: [], failures: [], unavailable: 0,
    passedWithSignals: 0, recoveredWithSignals: 0, flakyWithFinalSignals: 0,
    flakyFinalKinds: [], previousAttemptsWithSignals: 0,
  };
  const state: AggregationState = {
    summary, taxonomy, annotationPrefix, errorPatterns, groups: new Map(), noise: new Map(), flakyFinalKinds: new Map(),
  };
  for (const test of suite.allTests()) recordTest(test, state);
  finalizeGroups(state);
  return summary;
}