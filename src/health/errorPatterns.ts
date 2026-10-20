import fs from "node:fs";
import path from "node:path";
import type { HealthCategory } from "./aggregate";

/** Maps failure error text to a category, assessment and card message. */
export interface ErrorPattern {
  /** Regular expression source tested against the first error of a failed test. */
  match: string;
  /** Category name; patterns and signal categories with the same name are grouped. */
  category: string;
  /** Assessment for matching failures. Defaults to undetermined. */
  assessment?: "environment" | "regression" | "undetermined";
  /** Short line shown on the card. Must not contain `*`. */
  message: string;
}

export interface CompiledErrorPatterns {
  matchers: { regex: RegExp; message: string }[];
  categories: HealthCategory[];
}

export const defaultErrorPatterns: ErrorPattern[] = [
  {
    match: "net::ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED|CONNECTION_TIMED_OUT|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED)",
    category: "Network",
    assessment: "environment",
    message: "App unreachable from this network",
  },
];

function invalid(index: number, reason: string): Error {
  return new Error(`Invalid health error pattern at index ${index}: ${reason}`);
}

function validatePattern(pattern: ErrorPattern, index: number): RegExp {
  if (!pattern || typeof pattern !== "object") throw invalid(index, "expected an object");
  if (typeof pattern.match !== "string" || !pattern.match || pattern.match.length > 500) throw invalid(index, "match must be a non-empty string up to 500 characters");
  if (typeof pattern.category !== "string" || !pattern.category.trim() || pattern.category.length > 120 || pattern.category === "Other signals") throw invalid(index, "category must be a non-empty string up to 120 characters and not reserved");
  if (pattern.assessment !== undefined && !["environment", "regression", "undetermined"].includes(pattern.assessment)) throw invalid(index, "assessment must be environment, regression or undetermined");
  if (typeof pattern.message !== "string" || !pattern.message.trim() || pattern.message.length > 200 || pattern.message.includes("*")) throw invalid(index, "message must be a non-empty string up to 200 characters without `*`");
  try {
    return new RegExp(pattern.match);
  } catch {
    throw invalid(index, "match is not a valid regular expression");
  }
}

export function compileErrorPatterns(patterns: ErrorPattern[] = defaultErrorPatterns): CompiledErrorPatterns {
  if (!Array.isArray(patterns) || patterns.length > 100) throw new Error("Invalid health error patterns");
  const byCategory = new Map<string, HealthCategory>();
  const matchers = patterns.map((pattern, index) => {
    const regex = validatePattern(pattern, index);
    const existing = byCategory.get(pattern.category);
    if (existing) {
      if (!existing.kinds.includes(pattern.message)) existing.kinds.push(pattern.message);
    } else {
      byCategory.set(pattern.category, { name: pattern.category, kinds: [pattern.message], assessment: pattern.assessment ?? "undetermined" });
    }
    return { regex, message: pattern.message };
  });
  return { matchers, categories: [...byCategory.values()] };
}

/** Reads `{ "errorPatterns": [...] }` from a JSON file. */
export function readErrorPatternsFile(file: string): ErrorPattern[] {
  if (typeof file !== "string" || !file) throw new Error("Invalid health error patterns file");
  let parsed: { errorPatterns?: ErrorPattern[] };
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch {
    throw new Error("Unable to read health error patterns file");
  }
  if (!parsed || !Array.isArray(parsed.errorPatterns)) throw new Error("Health error patterns file must contain an errorPatterns array");
  return parsed.errorPatterns;
}

/** Adds pattern categories to a taxonomy; a same-named category receives the pattern kinds. */
export function mergePatternCategories(categories: HealthCategory[], patternCategories: HealthCategory[]): HealthCategory[] {
  const merged = categories.map(category => ({ ...category, kinds: [...category.kinds] }));
  for (const extra of patternCategories) {
    const existing = merged.find(category => category.name === extra.name);
    if (existing) existing.kinds.push(...extra.kinds);
    else merged.push(extra);
  }
  return merged;
}

export function matchErrorPatterns(text: string | undefined, compiled: CompiledErrorPatterns): string[] {
  if (!text) return [];
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "");
  return [...new Set(compiled.matchers.filter(({ regex }) => regex.test(clean)).map(({ message }) => message))];
}
