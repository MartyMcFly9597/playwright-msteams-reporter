import type { TestCase } from "@playwright/test/reporter";
import type { HealthSummary } from "./aggregate";
import { redactWebhookUrl } from "../utils/redactWebhookUrl";
import { redactSensitiveFields, sensitiveFieldPattern } from "./redactSensitiveFields";

export interface HealthDisplayOptions {
  /** Card heading. Defaults to `Test Run Health`. */
  title?: string;
  /** Optional environment label prefixed to the card heading. */
  environment?: string;
  /** Maximum failed-test detail groups to include. Defaults to 5; valid range is 0 to 100. */
  maxTests?: number;
  /** Maximum serialized webhook envelope size in UTF-8 bytes. Defaults to 26000; valid range is 4096 to 26000. */
  maxPayloadBytes?: number;
  /** Maps a failed test to its displayed label. Throwing or non-string results use the test title path. */
  testLabel?: (test: TestCase) => string;
  /** Optional domain-specific sanitizer applied after built-in sanitization. Invalid or throwing results omit the detail. */
  sanitizeText?: (text: string) => string;
  /** Primary results URL, or a callback resolved while creating the card. */
  linkToResultsUrl?: string | (() => string);
  /** Label for the primary results action. Defaults to `View test results`. */
  linkToResultsText?: string;
  /** Whether query strings and fragments are retained in the results action. Defaults to `strip-query`. */
  resultsLinkPolicy?: "strip-query" | "preserve";
}

export interface HealthRunContext {
  status: "passed" | "failed" | "timedout" | "interrupted";
  duration: number;
  errors: string[];
  errorsOmitted?: number;
  errorsSanitized?: boolean;
}

interface TextEntry {
  type: "TextBlock";
  text: string;
  wrap: true;
  weight?: "Bolder";
  fontType?: "Monospace";
  color?: "attention" | "warning" | "good";
}

const categoryEmoji: Record<string, string> = {
  Authentication: "🔐",
  "Backend and network": "📡",
  Timeout: "⏳",
  "Application errors": "⚠️",
  "Other signals": "❓",
  Network: "🌐",
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

const homePathPattern = /\b[A-Z]:(?:[\\/]+)Users[\\/]+[^\\/"'\r\n]+|\/(?:Users|home)\/[^/"'\r\n]+/gi;
const markdownCharacters = new Set(["\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", "!", "|", ">"]);

function sanitizeUrl(value: string): string {
  let candidate = value;
  while (candidate.endsWith("\\")) candidate = candidate.slice(0, -1);
  try {
    const url = new URL(candidate);
    if (/\/(?:webhookb2|incomingwebhook)\//i.test(url.pathname)) return `${url.origin}/<redacted-webhook-path>`;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/;(?:SharedAccessSignature|sig|signature|token|sv|se|sp|sr)=[^/]*$/i, "");
    return url.href;
  } catch {
    return "<redacted-url>";
  }
}

function builtinSanitize(value: string, webhookUrl?: string, layer = 0): string {
  const normalized = value.replace(/\u001b\[[0-9;]*m/g, "");
  const continuedCredential = (pattern: RegExp) => new RegExp(
    pattern.source + String.raw`(?:\\+[^nrt\s,;}"'\x60\\][^\s,;}"'\x60\\]*)*`, pattern.flags
  );
  const redactedSchemes = redactWebhookUrl(normalized, webhookUrl)
    .replace(continuedCredential(/\bBearer\s+[^\s,;}"'\x60\\]+/gi), "Bearer <redacted>")
    .replace(/\bBasic\s+([A-Za-z0-9+/]+=*)(?![A-Za-z0-9+/=])/gi, (match, credential: string) => {
      const decoded = Buffer.from(credential, "base64");
      return decoded.includes(58) && decoded.toString("base64").replace(/=+$/, "") === credential.replace(/=+$/, "")
        ? "<redacted-authorization>" : match;
    })
    .replace(continuedCredential(/\b(?:NTLM|Negotiate|ApiKey)\s+[^\s,;}"'\x60\\]+/gi), "<redacted-authorization>")
    .replace(new RegExp(String.raw`(^|[^A-Za-z0-9]|\\[nrt])(${sensitiveFieldPattern})(?:\s|\\[nrt])*[:=](?:\s|\\[nrt])*Token\s+[^\s,;}"'\x60\\]+`, "gi"), "$1$2: <redacted-authorization>")
    .replace(continuedCredential(/\bToken\s+[A-Za-z0-9._~+/-]{24,}=*(?![A-Za-z0-9._~+/=-])/gi), "Token <redacted>")
    .replace(continuedCredential(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g), "<redacted>");
  return redactSensitiveFields(redactedSchemes, layer, (decoded, nextLayer) => builtinSanitize(decoded, webhookUrl, nextLayer))
    .replace(/\bDigest\s+(?=[a-z][\w-]*\*?\s*=)[^\r\n]*/gi, "<redacted-authorization>")
    .replace(/\b(?:AccountKey|SharedAccessKey|Ocp-Apim-Subscription-Key|x-functions-key)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^;\s,}]+)/gi, "<redacted-key>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, sanitizeUrl)
    .replace(/([?&;])(sv|se|sp|sr|sig|signature|skoid|sktid|skt|ske|sks|skv)=([^&#;\s]+)/gi, (_match, prefix: string, key: string) => `${prefix}${key}=<redacted>`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
    .replace(homePathPattern, "<redacted-home>")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/[ \t]+/g, " ").trim();
}

function listPrefixIndices(line: string): Set<number> {
  const indices = new Set<number>();
  let index = 0;
  while (line[index]?.trim() === "") index += 1;
  if (["-", "+", ">"].includes(line[index]) && line[index + 1] === " ") {
    indices.add(index);
    return indices;
  }
  const digitsStart = index;
  while (line[index] !== undefined && line[index] >= "0" && line[index] <= "9") index += 1;
  if (index > digitsStart && line[index] === "." && line[index + 1] === " ") indices.add(index);
  return indices;
}

function escapeMarkdownLine(line: string): string {
  const prefixIndices = listPrefixIndices(line);
  let escaped = "";
  for (const [index, character] of Array.from(line).entries()) {
    const needsEscape = markdownCharacters.has(character) || prefixIndices.has(index);
    escaped += `${needsEscape ? "\\" : ""}${character}`;
  }
  return escaped;
}

function escapeMarkdown(value: string): string {
  return value.split("\n").map(line => {
    return escapeMarkdownLine(line);
  }).join("\n");
}

export function sanitizeHealthText(
  value: string,
  limit = 300,
  webhookUrl?: string,
  customSanitize?: (text: string) => string,
  escapeMarkdownText = true
): string {
  let sanitized = builtinSanitize(value, webhookUrl);
  if (customSanitize) {
    try {
      const custom = customSanitize(sanitized);
      if (typeof custom !== "string") return escapeMarkdownText ? escapeMarkdown("<detail omitted>") : "<detail omitted>";
      sanitized = builtinSanitize(custom, webhookUrl);
    } catch {
      return escapeMarkdownText ? escapeMarkdown("<detail omitted>") : "<detail omitted>";
    }
  }
  const clipped = Array.from(sanitized).slice(0, limit).join("").trim();
  return escapeMarkdownText ? escapeMarkdown(clipped) : clipped;
}

function textEntry(text: string, bold = false, color?: TextEntry["color"]): TextEntry {
  return { type: "TextBlock", text, wrap: true, ...(bold ? { weight: "Bolder" as const } : {}), ...(color ? { color } : {}) };
}

function addResultsAction(options: HealthDisplayOptions, webhookUrl: string | undefined, clean: (value: string, limit?: number, escapeMarkdownText?: boolean) => string) {
  const value = typeof options.linkToResultsUrl === "function" ? options.linkToResultsUrl() : options.linkToResultsUrl;
  if (typeof value !== "string" || !value || value.length > 2000) return [];
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      redactWebhookUrl(value, webhookUrl) !== value || redactWebhookUrl(url.href, webhookUrl) !== url.href) return [];
    if (options.resultsLinkPolicy !== "preserve") { url.search = ""; url.hash = ""; }
    if (url.href.length > 2000) return [];
    return [{ type: "Action.OpenUrl", title: clean(options.linkToResultsText ?? "View test results", 100), url: url.href }];
  } catch {
    return [];
  }
}

function categoryDetails(summary: HealthSummary, clean: (value: string, limit?: number) => string): TextEntry[][] {
  const details = summary.categories.length ? [
    [textEntry("Failure evidence categories may overlap; each failure has one assessment.")],
  ] : [];
  for (const category of summary.categories) {
    const emoji = Object.prototype.hasOwnProperty.call(categoryEmoji, category.name) ? categoryEmoji[category.name] : undefined;
    details.push([textEntry(`${emoji ? `${emoji} ` : ""}${clean(category.name, 120)}: ${category.failed} failed tests`, true)]);
    for (const kind of category.kinds) details.push([textEntry(`${clean(kind.kind, 120)}: ${kind.tests} tests`)]);
  }
  return details;
}

function failureDetail(failure: HealthSummary["failures"][number], options: HealthDisplayOptions, clean: (value: string, limit?: number) => string): TextEntry[] {
  let label = failure.test.titlePath().filter(Boolean).join(" > ");
  if (options.testLabel) {
    try {
      const custom = options.testLabel(failure.test);
      if (typeof custom === "string") label = custom;
    } catch { /* Fall back to the Playwright title path. */ }
  }
  const entries = [textEntry(clean(label), true)];
  const error = failure.result?.errors?.[0];
  const diagnostic = error?.message ?? error?.value;
  if (diagnostic) entries.push(textEntry(clean(diagnostic, 2000)));
  return entries;
}

function developerReviewHeading(summary: HealthSummary): TextEntry {
  const count = summary.failures.filter(failure => failure.categories.length === 0).length;
  return textEntry(`🤷 Developer review (no actionable environment signal): ${count} failed tests`, true, "attention");
}

function failureDetails(summary: HealthSummary, options: HealthDisplayOptions, clean: (value: string, limit?: number) => string): TextEntry[][] {
  const details = categoryDetails(summary, clean);
  const shown = summary.failures.slice(0, options.maxTests ?? 5);
  const signalled = shown.filter(failure => failure.categories.length > 0);
  const unsignalled = shown.filter(failure => failure.categories.length === 0);
  details.push(
    ...summary.noise.map(noise => [textEntry(`ℹ️ ${clean(noise.kind, 120)}: ambient noise on ${noise.tests} tests; not a failure cause.`)]),
    ...signalled.map(failure => failureDetail(failure, options, clean))
  );
  if (summary.failures.some(failure => failure.categories.length === 0)) {
    const [firstUnsignalled, ...rest] = unsignalled.map(failure => failureDetail(failure, options, clean));
    details.push([developerReviewHeading(summary), ...(firstUnsignalled ?? [])], ...rest);
  }
  return details;
}

function flakyFinalSignalDetails(summary: HealthSummary, clean: (value: string, limit?: number) => string): TextEntry[][] {
  if (!summary.flakyWithFinalSignals) return [];
  return summary.flakyFinalKinds.map(({ kind, tests }) => [textEntry(`🟡 ${clean(kind, 120)}: final-attempt signal on ${tests} flaky tests; recovery not established.`, false, "warning")]);
}

function baseEntries(summary: HealthSummary, options: HealthDisplayOptions, context: HealthRunContext, clean: (value: string, limit?: number) => string): TextEntry[] {
  const title = [options.environment, options.title ?? "Test Run Health"].filter(Boolean).join(" - ");
  const entries = [
    textEntry(`🩺 ${clean(title, 160)}`, true),
    textEntry(`⏱ ${summary.outcomes.unexpected} failed; ${summary.outcomes.expected} expected; ${summary.outcomes.flaky} flaky; ${summary.outcomes.skipped} skipped. Run: ${context.status}; ${formatDuration(context.duration)}.`),
  ];
  if (summary.outcomes.unexpected === 0) {
    const passedCleanly = context.status === "passed" && context.errors.length === 0 && !context.errorsOmitted;
    entries.push(passedCleanly
      ? textEntry("✅ No failures.", false, "good")
      : textEntry(`⚠️ No failed tests, but the run did not complete cleanly (${context.status}); see runner errors.`, false, "attention"));
  } else {
    const { environment, regression, mixed, undetermined } = summary.assessments;
    const color = environment > 0 && regression + mixed + undetermined === 0 ? "warning" : "attention";
    entries.push(textEntry(`🧭 Evidence assessment (best guess): ${environment} environment-suspect; ${regression} regression-suspect; ${mixed} mixed; ${undetermined} Cause undetermined / developer review.`, false, color));
  }
  if (summary.unavailable) entries.push(textEntry(`Final signal evidence unavailable or unsupported on ${summary.unavailable} tests. No cause inferred.`));
  if (summary.passedWithSignals || summary.recoveredWithSignals || summary.previousAttemptsWithSignals) {
    entries.push(textEntry(`🟡 Passed with signals: ${summary.passedWithSignals}. 🔁 Recovered flaky tests with signal evidence: ${summary.recoveredWithSignals}. Tests with superseded-attempt signals: ${summary.previousAttemptsWithSignals}. Not included in final-failure assessments.`, false, "warning"));
  }
  if (summary.flakyWithFinalSignals) {
    entries.push(textEntry(`🟡 Flaky tests with final-attempt signals: ${summary.flakyWithFinalSignals}. Recovery not established; not included in final-failure assessments.`, false, "warning"));
  }
  return entries;
}

export function buildHealthMessage(summary: HealthSummary, options: HealthDisplayOptions, context: HealthRunContext, webhookUrl?: string): string {
  const clean = (value: string, limit = 300, escapeMarkdownText = true) => sanitizeHealthText(value, limit, webhookUrl, options.sanitizeText, escapeMarkdownText);
  const body = baseEntries(summary, options, context, clean);
  const errors = context.errors.map(error => [textEntry(`Runner error: ${context.errorsSanitized ? error : clean(error)}`)]);
  const errorOmission = context.errorsOmitted ? [[textEntry(`${context.errorsOmitted} additional runner errors omitted.`)]] : [];
  const detailGroups = [...errorOmission, ...errors, ...flakyFinalSignalDetails(summary, clean), ...failureDetails(summary, options, clean)];
  let actions = addResultsAction(options, webhookUrl, clean);
  const serialize = (entries: TextEntry[]) => JSON.stringify({
    type: "message",
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null,
      content: { type: "AdaptiveCard", version: "1.4", $schema: "https://adaptivecards.io/schemas/adaptive-card.json", body: entries, msteams: { width: "Full" }, actions } }],
  });
  const budget = options.maxPayloadBytes ?? 26000;
  let omitted = Math.max(0, summary.failures.length - (options.maxTests ?? 5));
  const omission = (count: number) => textEntry(`${count} additional detail groups omitted; aggregate counts are unchanged.`);
  const minimumMessage = () => serialize([...body, omission(detailGroups.length + omitted)]);
  if (Buffer.byteLength(minimumMessage(), "utf8") > budget && actions.length) actions = [];
  if (Buffer.byteLength(minimumMessage(), "utf8") > budget) {
    throw new Error("Health payload budget is too small for summary and results link");
  }
  const selected = [...body];
  for (const [index, group] of detailGroups.entries()) {
    const following = detailGroups.length - index - 1 + omitted;
    const candidate = [...selected, ...group];
    if (following) candidate.push(omission(following));
    if (Buffer.byteLength(serialize(candidate), "utf8") > budget) {
      omitted += detailGroups.length - index;
      break;
    }
    selected.push(...group);
  }
  if (omitted) selected.push(omission(omitted));
  return serialize(selected);
}
