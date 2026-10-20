import type { FullConfig, FullResult, Reporter, Suite, TestError } from "@playwright/test/reporter";
import type { MsTeamsReporterOptions } from ".";
import { aggregateHealth, compileCategories, defaultCategories } from "./health/aggregate";
import type { HealthCategory } from "./health/aggregate";
import { compileErrorPatterns, defaultErrorPatterns, mergePatternCategories, readErrorPatternsFile } from "./health/errorPatterns";
import type { ErrorPattern } from "./health/errorPatterns";
import { buildHealthMessage, sanitizeHealthText } from "./health/render";
import type { HealthDisplayOptions } from "./health/render";
import { resolveWebhookUrl } from "./utils/resolveWebhookUrl";
import { resolveWebhookTimeout } from "./utils/resolveWebhookTimeout";
import { sendWebhookMessage } from "./utils/sendWebhookMessage";

export type { HealthCategory } from "./health/aggregate";
export type { ErrorPattern } from "./health/errorPatterns";

/** Configuration for the optional health summary reporter. */
export interface HealthReporterOptions extends HealthDisplayOptions, Pick<MsTeamsReporterOptions,
  "webhookUrl" | "webhookUrlEnv" | "webhookTimeoutMs" | "webhookType" | "quiet" | "debug" |
  "notifyOnSuccess" | "reportOnEmpty" | "shouldRun"> {
  /** Disable this reporter without changing other reporters. Defaults to enabled. */
  enabled?: boolean;
  /** Prefix used to recognize Playwright annotations as environment-signal evidence. Defaults to `env-signal:`. */
  annotationPrefix?: string;
  /** Ordered signal-category mapping. When supplied, replaces the built-in categories. */
  categories?: HealthCategory[];
  /** Path to a JSON file `{ "errorPatterns": [...] }` that replaces the built-in failure-text patterns. */
  errorPatternsFile?: string;
}

function validateLimitsAndEnums(options: HealthReporterOptions): void {
  const { maxTests = 5, maxPayloadBytes = 26000, annotationPrefix = "env-signal:" } = options;
  if (!Number.isInteger(maxTests) || maxTests < 0 || maxTests > 100 ||
      !Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 4096 || maxPayloadBytes > 26000 ||
      typeof annotationPrefix !== "string" || !annotationPrefix || annotationPrefix.length > 100 ||
      (options.webhookType !== undefined && !["msteams", "powerautomate"].includes(options.webhookType)) ||
      (options.resultsLinkPolicy !== undefined && !["strip-query", "preserve"].includes(options.resultsLinkPolicy))) {
    throw new Error("Invalid health reporter options");
  }
}

function validateBooleanOptions(options: HealthReporterOptions): void {
  for (const name of ["enabled", "quiet", "debug", "notifyOnSuccess", "reportOnEmpty"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "boolean") throw new Error("Invalid health reporter flag");
  }
}

function validateDisplayOptions(options: HealthReporterOptions): void {
  for (const name of ["title", "environment", "linkToResultsText"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "string") throw new Error("Invalid health display option");
  }
}

function validateCallbacks(options: HealthReporterOptions): void {
  for (const name of ["shouldRun", "testLabel", "sanitizeText"] as const) {
    if (options[name] !== undefined && typeof options[name] !== "function") throw new Error("Invalid health callback");
  }
}

function validateResultsLink(options: HealthReporterOptions): void {
  if (options.linkToResultsUrl !== undefined && !["string", "function"].includes(typeof options.linkToResultsUrl)) {
    throw new Error("Invalid health results URL");
  }
}

function validateOptions(options: HealthReporterOptions): void {
  validateLimitsAndEnums(options);
  validateBooleanOptions(options);
  validateDisplayOptions(options);
  validateCallbacks(options);
  validateResultsLink(options);
}

/** Sends a separate bounded health summary after a Playwright test run. */
export default class HealthReporter implements Reporter {
  private suite?: Suite;
  private readonly options: HealthReporterOptions;
  private readonly taxonomy: ReturnType<typeof compileCategories>;
  private readonly errorPatterns: ReturnType<typeof compileErrorPatterns>;
  private readonly runnerErrors: string[] = [];
  private runnerErrorsOmitted = 0;

  /** Create a health reporter. Delivery and notification gates follow the supplied options. */
  constructor(options: HealthReporterOptions = {}) {
    validateOptions(options);
    const patterns: ErrorPattern[] = options.errorPatternsFile === undefined ? defaultErrorPatterns : readErrorPatternsFile(options.errorPatternsFile);
    this.errorPatterns = compileErrorPatterns(patterns);
    this.taxonomy = compileCategories(mergePatternCategories(options.categories ?? defaultCategories, this.errorPatterns.categories));
    this.options = {
      ...options,
      webhookUrl: resolveWebhookUrl(options.webhookUrl, options.webhookUrlEnv),
      webhookTimeoutMs: resolveWebhookTimeout(options.webhookTimeoutMs),
    };
  }

  printsToStdio(): boolean { return false; }

  onBegin(_config: FullConfig, suite: Suite): void { this.suite = suite; }

  onError(error: TestError): void {
    if (this.runnerErrors.length < 20) {
      this.runnerErrors.push(sanitizeHealthText(error.message ?? error.value ?? "Runner error", 300, this.options.webhookUrl, this.options.sanitizeText));
    } else {
      this.runnerErrorsOmitted += 1;
    }
  }

  async onEnd(result: FullResult): Promise<void> {
    try {
      await this.report(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Health report failed";
      console.error(`Health reporter failed: ${sanitizeHealthText(message, 300, this.options.webhookUrl, this.options.sanitizeText)}`);
    }
  }

  private async report(result: FullResult): Promise<void> {
    if (this.options.enabled === false) return;
    if (!this.suite && this.runnerErrors.length === 0 && result.status === "passed") return;
    if (this.suite && this.options.shouldRun && !this.options.shouldRun(this.suite)) return;
    const suite = this.suite ?? { allTests: () => [] } as unknown as Suite;
    const summary = aggregateHealth(suite, this.taxonomy, this.options.annotationPrefix, this.errorPatterns);
    const total = Object.values(summary.outcomes).reduce((sum, count) => sum + count, 0);
    const runFailed = result.status !== "passed" || this.runnerErrors.length > 0;
    const hasSignals = summary.categories.length > 0 ||
      summary.passedWithSignals > 0 || summary.recoveredWithSignals > 0 || summary.flakyWithFinalSignals > 0 ||
      summary.previousAttemptsWithSignals > 0;
    if (total === 0 && !runFailed && !this.options.reportOnEmpty) return;
    if (!runFailed && summary.outcomes.unexpected === 0 && this.options.notifyOnSuccess === false) return;
    if (!runFailed && !summary.outcomes.unexpected && !hasSignals && !(total === 0 && this.options.reportOnEmpty)) return;
    const body = buildHealthMessage(summary, this.options, {
      status: result.status, duration: result.duration, errors: this.runnerErrors,
      errorsOmitted: this.runnerErrorsOmitted, errorsSanitized: true,
    }, this.options.webhookUrl);
    if (!this.options.quiet) console.log(`Test Run Health: ${summary.outcomes.unexpected} failed; ${summary.assessments.undetermined} undetermined.`);
    if (this.options.debug) console.log(body);
    if (!this.options.webhookUrl) {
      console.error("No webhook URL provided for health reporter");
      return;
    }
    await sendWebhookMessage(this.options.webhookUrl, body, this.options);
  }
}