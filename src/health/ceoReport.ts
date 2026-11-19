import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TestCase } from "@playwright/test/reporter";
import { redactWebhookUrl } from "../utils/redactWebhookUrl";
import type { HealthSummary } from "./aggregate";
import { sanitizeHealthText } from "./render";
import type { HealthDisplayOptions, HealthRunContext } from "./render";

export interface CeoIssueMapping {
  id: string;
  match: string[];
  label: string;
  impact: string;
  action: string;
}

interface CeoIssueMappingOverride extends Partial<CeoIssueMapping> {
  id: string;
  enabled?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validateRule(rule: unknown): CeoIssueMappingOverride {
  if (!isRecord(rule) || typeof rule.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(rule.id) ||
      (rule.enabled !== undefined && typeof rule.enabled !== "boolean")) {
    throw new Error("Invalid CEO mapping configuration");
  }
  if (rule.enabled === false) return { id: rule.id, enabled: false };
  const { match, label, impact, action } = rule;
  if ((match !== undefined && (!Array.isArray(match) || match.length === 0 || match.length > 50 ||
      match.some(value => typeof value !== "string" || !value.trim() || value.length > 200))) ||
      (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 160)) ||
      (impact !== undefined && (typeof impact !== "string" || !impact.trim() || impact.length > 500)) ||
      (action !== undefined && (typeof action !== "string" || !action.trim() || action.length > 500))) {
    throw new Error("Invalid CEO mapping configuration");
  }
  return {
    id: rule.id,
    ...(match !== undefined ? { match: [...match] as string[] } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(impact !== undefined ? { impact } : {}),
    ...(action !== undefined ? { action } : {}),
  };
}

function readDefaultMappings(): CeoIssueMapping[] {
  try {
    const document: unknown = JSON.parse(readFileSync(resolve(__dirname, "../../ceo-report-mappings.json"), "utf8"));
    if (!isRecord(document) || !Array.isArray(document.rules)) throw new Error("Invalid built-in CEO mappings");
    const rules = document.rules.map(validateRule);
    if (rules.some(rule => rule.enabled === false) || new Set(rules.map(rule => rule.id)).size !== rules.length) {
      throw new Error("Invalid built-in CEO mappings");
    }
    return rules as CeoIssueMapping[];
  } catch {
    throw new Error("Unable to load built-in CEO mappings");
  }
}

export const defaultCeoMappings = readDefaultMappings();

export function loadCeoMappings(filePath?: string): CeoIssueMapping[] {
  const mappings = new Map(defaultCeoMappings.map(rule => [rule.id, { ...rule, match: [...rule.match] }]));
  if (!filePath) return [...mappings.values()];

  let document: unknown;
  try {
    document = JSON.parse(readFileSync(resolve(filePath), "utf8"));
  } catch {
    throw new Error("Unable to load CEO mapping configuration");
  }
  if (!isRecord(document) || !Array.isArray(document.rules) || document.rules.length > 200) {
    throw new Error("Invalid CEO mapping configuration");
  }

  const seen = new Set<string>();
  for (const value of document.rules) {
    const rule = validateRule(value);
    if (seen.has(rule.id)) throw new Error("Invalid CEO mapping configuration");
    seen.add(rule.id);
    if (rule.enabled === false) {
      if (!mappings.delete(rule.id)) throw new Error("Invalid CEO mapping configuration");
      continue;
    }
    const existing = mappings.get(rule.id);
    if (!existing && (rule.match === undefined || rule.label === undefined || rule.impact === undefined || rule.action === undefined)) {
      throw new Error("Invalid CEO mapping configuration");
    }
    mappings.set(rule.id, {
      ...existing,
      ...rule,
      match: [...(rule.match ?? existing?.match ?? [])],
    } as CeoIssueMapping);
  }
  return [...mappings.values()];
}

interface IssueGroup {
  id: string;
  label: string;
  impact: string;
  action: string;
  count: number;
  fallback?: boolean;
}

function testLabel(test: TestCase, options: HealthDisplayOptions, clean: CleanText): string {
  let label = test.titlePath().filter(Boolean).join(" > ");
  if (options.testLabel) {
    try {
      const custom = options.testLabel(test);
      if (typeof custom === "string") label = custom;
    } catch { /* Use the Playwright title path. */ }
  }
  return clean(label || "Unnamed test", 300, false);
}

function failureText(failure: HealthSummary["failures"][number], options: HealthDisplayOptions, clean: CleanText): string {
  const error = failure.result?.errors?.[0];
  const diagnostic = error?.message ?? error?.value ?? "";
  const signals = failure.signalKinds?.join(" ") ?? "";
  return [testLabel(failure.test, options, clean), clean(diagnostic, 1200, false), clean(signals, 500, false), ...failure.categories.map(category => clean(category, 120, false))]
    .filter(Boolean).join("\n").toLocaleLowerCase();
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function resultActions(options: HealthDisplayOptions, webhookUrl?: string): { type: string; title: string; url: string }[] {
  const value = typeof options.linkToResultsUrl === "function" ? options.linkToResultsUrl() : options.linkToResultsUrl;
  if (typeof value !== "string" || !value || value.length > 2000) return [];
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        redactWebhookUrl(value, webhookUrl) !== value || redactWebhookUrl(url.href, webhookUrl) !== url.href) return [];
    if (options.resultsLinkPolicy !== "preserve") { url.search = ""; url.hash = ""; }
    if (url.href.length > 2000) return [];
    return [{ type: "Action.OpenUrl", title: sanitizeHealthText(options.linkToResultsText ?? "View test results", 100, webhookUrl, options.sanitizeText), url: url.href }];
  } catch {
    return [];
  }
}

type CleanText = (value: string, limit?: number, escapeMarkdownText?: boolean) => string;
type CeoTextBlock = { type: string; text: string; wrap?: boolean; weight?: string; color?: string };

function addFailureGroup(
  groups: Map<string, IssueGroup>,
  failure: HealthSummary["failures"][number],
  options: HealthDisplayOptions,
  mappings: CeoIssueMapping[],
  clean: CleanText
): void {
  const source = failureText(failure, options, clean);
  const mapping = mappings.find(rule => rule.match.some(term => source.includes(term.toLowerCase())));
  const error = failure.result?.errors?.[0];
  const diagnostic = clean(error?.message ?? error?.value ?? "", 220, false);
  const id = mapping?.id ?? `unmapped:${diagnostic || testLabel(failure.test, options, clean)}`;
  const existing = groups.get(id);
  if (existing) {
    existing.count += 1;
    return;
  }
  groups.set(id, mapping ? {
    id: mapping.id,
    label: mapping.label,
    impact: mapping.impact,
    action: mapping.action,
    count: 1,
  } : {
    id,
    label: "Other issue",
    impact: diagnostic ? `Observed error: ${diagnostic}` : "Failure details were unavailable.",
    action: "Review the detailed test report.",
    count: 1,
    fallback: true,
  });
}

function formatIssueGroup(group: IssueGroup): IssueGroup {
  if (group.fallback) {
    group.label = `Other issue (${group.count})`;
    group.impact = group.impact.startsWith("Observed error:")
      ? group.impact.replace(/^Observed error:/, `Observed error (${group.count} tests):`) + "."
      : `Failure details unavailable for ${group.count} tests.`;
    return group;
  }
  group.impact = group.impact.replace(/\{count\}/g, String(group.count));
  group.label = `${group.label} (${group.count})`;
  return group;
}

function groupFailures(
  summary: HealthSummary,
  options: HealthDisplayOptions,
  mappings: CeoIssueMapping[],
  clean: CleanText
): { groups: IssueGroup[]; totalGroups: number } {
  const grouped = new Map<string, IssueGroup>();
  for (const failure of summary.failures) addFailureGroup(grouped, failure, options, mappings, clean);
  const allGroups = [...grouped.values()].map(formatIssueGroup)
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
  return { groups: allGroups.slice(0, 3), totalGroups: allGroups.length };
}

function overviewEntries(summary: HealthSummary, options: HealthDisplayOptions, context: HealthRunContext, groupCount: number, clean: CleanText): CeoTextBlock[] {
  const total = summary.outcomes.expected + summary.outcomes.unexpected + summary.outcomes.flaky + summary.outcomes.skipped;
  const title = [options.environment, options.title ?? "Test Run Health"]
    .filter((value): value is string => Boolean(value)).map(value => clean(value, 160, true)).join(" - ");
  const hasSignalEvidence = summary.passedWithSignals > 0 || summary.recoveredWithSignals > 0 ||
    summary.flakyWithFinalSignals > 0 || summary.previousAttemptsWithSignals > 0;
  const entries: CeoTextBlock[] = [
    { type: "TextBlock", text: title, wrap: true, weight: "Bolder" },
    { type: "TextBlock", text: `${summary.outcomes.expected} expected; ${summary.outcomes.unexpected} unexpected; ${summary.outcomes.flaky} flaky; ${summary.outcomes.skipped} skipped; ${total} total. Run ${clean(context.status, 40, true)} in ${formatDuration(context.duration)}.`, wrap: true },
  ];
  if (groupCount === 0) {
    const passedCleanly = context.status === "passed" && context.errors.length === 0 && !context.errorsOmitted && !hasSignalEvidence;
    entries.push({
      type: "TextBlock",
      text: passedCleanly
        ? "No failed tests or reported issues."
        : hasSignalEvidence
          ? `Signal evidence observed: ${summary.passedWithSignals} passing, ${summary.recoveredWithSignals} recovered, ${summary.flakyWithFinalSignals} final-flaky, and ${summary.previousAttemptsWithSignals} prior-attempt test signals.`
          : "The run did not complete cleanly; review runner errors.",
      wrap: true,
      color: passedCleanly ? "good" : "attention",
    });
  }
  return entries;
}

function issueEntries(groups: IssueGroup[], totalGroups: number, clean: CleanText): CeoTextBlock[] {
  const entries: CeoTextBlock[] = [];
  for (const group of groups) {
    entries.push(
      { type: "TextBlock", text: clean(group.label, 160, true), wrap: true, weight: "Bolder" },
      { type: "TextBlock", text: clean(group.impact, 500, true), wrap: true },
    );
    if (group.fallback) entries.push({ type: "TextBlock", text: "Cause unconfirmed.", wrap: true, color: "warning" });
    entries.push({ type: "TextBlock", text: `Next: ${clean(group.action, 300, true)}`, wrap: true });
  }
  if (totalGroups > groups.length) {
    entries.push({ type: "TextBlock", text: `${totalGroups - groups.length} additional issue groups omitted; totals include all failures.`, wrap: true });
  }
  return entries;
}

function runnerErrorEntries(context: HealthRunContext, clean: CleanText): CeoTextBlock[] {
  const entries: CeoTextBlock[] = context.errors.slice(0, 2).map(error => ({
    type: "TextBlock", text: `Runner issue: ${clean(error, 300, true)} (cause unconfirmed).`, wrap: true, color: "attention",
  }));
  const totalErrors = context.errors.length + (context.errorsOmitted ?? 0);
  const omittedErrors = Math.max(0, totalErrors - entries.length);
  if (omittedErrors) entries.push({
    type: "TextBlock", text: `${omittedErrors} additional runner issues omitted.`, wrap: true,
  });
  return entries;
}

export function buildCeoHealthMessage(
  summary: HealthSummary,
  options: HealthDisplayOptions,
  context: HealthRunContext,
  mappings: CeoIssueMapping[],
  webhookUrl?: string
): string {
  const clean = (value: string, limit = 300, escapeMarkdownText = false) =>
    sanitizeHealthText(value, limit, webhookUrl, options.sanitizeText, escapeMarkdownText);
  const { groups, totalGroups } = groupFailures(summary, options, mappings, clean);
  const overview = overviewEntries(summary, options, context, totalGroups, clean);
  const runnerErrors = runnerErrorEntries(context, clean);
  const actions = resultActions(options, webhookUrl);
  const budget = options.maxPayloadBytes ?? 26000;
  let visibleGroups = groups.length;
  const serialize = (entries: CeoTextBlock[], cardActions: ReturnType<typeof resultActions>) => JSON.stringify({
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        type: "AdaptiveCard",
        version: "1.4",
        $schema: "https://adaptivecards.io/schemas/adaptive-card.json",
        body: entries,
        msteams: { width: "Full" },
        actions: cardActions,
      },
    }],
  });
  const createBody = (count: number) => {
    const omitted = totalGroups - count;
    const entries = [
      ...overview,
      ...issueEntries(groups.slice(0, count), count, clean),
      ...(omitted ? [{ type: "TextBlock", text: `${omitted} additional issue groups omitted; totals include all failures.`, wrap: true } satisfies CeoTextBlock] : []),
      ...runnerErrors,
    ];
    return entries;
  };
  while (visibleGroups > 0 && Buffer.byteLength(serialize(createBody(visibleGroups), actions), "utf8") > budget) {
    visibleGroups -= 1;
  }
  let body = createBody(visibleGroups);
  let cardActions = actions;
  if (Buffer.byteLength(serialize(body, cardActions), "utf8") > budget && cardActions.length) {
    cardActions = [];
  }
  if (Buffer.byteLength(serialize(body, cardActions), "utf8") > budget) {
    body = [...overview, { type: "TextBlock", text: `${totalGroups} issue groups omitted; totals include all failures.`, wrap: true }, ...runnerErrors];
    if (Buffer.byteLength(serialize(body, cardActions), "utf8") > budget) {
      const omittedRunnerErrors = context.errors.length + (context.errorsOmitted ?? 0);
      body = [
        ...overview,
        { type: "TextBlock", text: `${totalGroups} issue groups omitted; totals include all failures.`, wrap: true },
        ...(omittedRunnerErrors > 0 ? [{ type: "TextBlock", text: `${omittedRunnerErrors} runner issues omitted to fit the payload limit.`, wrap: true } satisfies CeoTextBlock] : []),
      ];
    }
  }
  const serialized = serialize(body, cardActions);
  if (Buffer.byteLength(serialized, "utf8") > budget) throw new Error("CEO health summary exceeds payload budget");
  return serialized;
}
