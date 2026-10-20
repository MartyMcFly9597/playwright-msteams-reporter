import fs from "node:fs";
import path from "node:path";

/** Maps failure error text to a category, assessment and card message. */
export interface ErrorPattern {
  /** Regular expression source tested against the first error of a failed test. */
  match: string;
  /** Category name; a same-named signal category groups with it, and a noise category makes the match noise. */
  category: string;
  /** Assessment for matching failures. Defaults to undetermined. */
  assessment?: "environment" | "regression" | "undetermined";
  /** Short line shown on the card. */
  message: string;
}

export interface CompiledErrorPatterns {
  matchers: { regex: RegExp; category: string; assessment: "environment" | "regression" | "undetermined"; message: string }[];
}

export interface ErrorPatternMatch {
  category: string;
  assessment: "environment" | "regression" | "undetermined";
  message: string;
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
  if (typeof pattern.message !== "string" || !pattern.message.trim() || pattern.message.length > 200) throw invalid(index, "message must be a non-empty string up to 200 characters");
  try {
    return new RegExp(pattern.match);
  } catch {
    throw invalid(index, "match is not a valid regular expression");
  }
}

export function compileErrorPatterns(patterns: ErrorPattern[] = defaultErrorPatterns): CompiledErrorPatterns {
  if (!Array.isArray(patterns) || patterns.length > 100) throw new Error("Invalid health error patterns");
  const matchers = patterns.map((pattern, index) => ({
    regex: validatePattern(pattern, index),
    category: pattern.category,
    assessment: pattern.assessment ?? "undetermined",
    message: pattern.message,
  }));
  return { matchers };
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

export function matchErrorPatterns(text: string | undefined, compiled: CompiledErrorPatterns): ErrorPatternMatch[] {
  if (!text) return [];
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "");
  const matches = new Map<string, ErrorPatternMatch>();
  for (const { regex, category, assessment, message } of compiled.matchers) {
    if (regex.test(clean)) matches.set(`${category}\u0000${message}`, { category, assessment, message });
  }
  return [...matches.values()];
}
