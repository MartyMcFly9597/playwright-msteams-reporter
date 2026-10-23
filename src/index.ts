import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  FullResult,
} from "@playwright/test/reporter";
import { processResults } from "./processResults";
import { WebhookType } from "./models";
import { redactWebhookUrl } from "./utils/redactWebhookUrl";
import { resolveWebhookUrl } from "./utils/resolveWebhookUrl";
import { resolveWebhookTimeout } from "./utils/resolveWebhookTimeout";

/** A named URL action appended to a Teams Adaptive Card. */
export interface Link {
  /** Button text. Links with empty text are omitted. */
  text: string;
  /** Absolute HTTP(S) URL, or a callback resolved when the report is generated. */
  url: string | ((this: MsTeamsReporterOptions) => string);
}

/** Configuration for the Microsoft Teams Playwright reporter. */
export interface MsTeamsReporterOptions {
  /** Explicit webhook URL. An empty string disables delivery and environment fallback. */
  webhookUrl?: string;
  /** Environment variable name used when `webhookUrl` is omitted. Defaults to `MSTEAMS_WEBHOOK_URL`. */
  webhookUrlEnv?: string;
  /** Request and response-body deadline in milliseconds. Defaults to 10000. */
  webhookTimeoutMs?: number;
  /** Webhook payload family. Defaults to `powerautomate`. */
  webhookType?: WebhookType;
  /** Card heading. Defaults to `Playwright Test Results`. */
  title?: string;
  /** URL for the primary results action; callbacks run with this options object as `this`. */
  linkToResultsUrl?: string | ((this: MsTeamsReporterOptions) => string);
  /** Label for `linkToResultsUrl`. Defaults to `View test results`. */
  linkToResultsText?: string;
  /** URL shown only when the run has failed tests; callbacks run with this options object as `this`. */
  linkUrlOnFailure?: string | ((this: MsTeamsReporterOptions) => string);
  /** Failure action label. Defaults to `View failed tests`. An empty label omits the action. */
  linkTextOnFailure?: string;
  /** Additional named actions, placed after the primary results action and before the failure action. */
  links?: Link[];
  /** Send a notification for a successful run. Defaults to true. */
  notifyOnSuccess?: boolean;
  /** Comma-separated email addresses to mention when tests fail. */
  mentionOnFailure?: string;
  /** Mention message template. `{mentions}` is replaced with Teams mention markup. */
  mentionOnFailureText?: string;
  /** Include an emoji matching the test result in the card. Defaults to false. */
  enableEmoji?: boolean;
  /** Suppress forwarded test output and success chatter. Defaults to false. */
  quiet?: boolean;
  /** Log redacted reporter options and the outgoing card. Defaults to false. */
  debug?: boolean;
  /** Predicate that can suppress reporting for a suite. Defaults to a predicate that returns true. */
  shouldRun?: (suite: Suite) => boolean;
  /** Send a report when the run contains no tests. Defaults to false. */
  reportOnEmpty?: boolean;
  /** Include the run duration in the card. Defaults to false. */
  enableDuration?: boolean;
  /** Mention commit or pull request authors when Playwright git metadata is available. Defaults to false. */
  mentionAuthors?: boolean;
}

export default class MsTeamsReporter implements Reporter {
  private suite: Suite | undefined;
  private startTime: number | undefined;
  private gitAuthors: string[] | undefined;

  constructor(private readonly options: MsTeamsReporterOptions = {}) {
    const defaultOptions: MsTeamsReporterOptions = {
      webhookUrl: undefined,
      webhookType: "powerautomate",
      title: "Playwright Test Results",
      linkToResultsUrl: undefined,
      linkToResultsText: "View test results",
      linkUrlOnFailure: undefined,
      linkTextOnFailure: "View failed tests",
      notifyOnSuccess: true,
      mentionOnFailure: undefined,
      mentionOnFailureText: "{mentions} please validate the test results.",
      enableEmoji: false,
      quiet: false,
      debug: false,
      shouldRun: () => true,
      reportOnEmpty: false,
      enableDuration: false,
      mentionAuthors: false,
    };

    this.options = {
      ...defaultOptions,
      ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
      webhookUrl: resolveWebhookUrl(options.webhookUrl, options.webhookUrlEnv),
      webhookTimeoutMs: resolveWebhookTimeout(options.webhookTimeoutMs),
    };

    if (this.options.webhookType !== "msteams" && this.options.webhookType !== "powerautomate") {
      throw new Error("webhookType must be either msteams or powerautomate");
    }

    console.log(`Using Microsoft Teams reporter`);

    if (this.options.debug) {
      console.log(`Using debug mode`);
      console.log(redactWebhookUrl(
        `Options: ${JSON.stringify(this.options, null, 2)}`,
        this.options.webhookUrl
      ));
    }
  }

  onBegin(config: FullConfig, suite: Suite) {
    this.suite = suite;
    if (this.options.enableDuration) {
      this.startTime = Date.now();
    }
    if (this.options.mentionAuthors && config?.metadata) {
      const authors: string[] = [];
      const metadata = config.metadata as FullConfig["metadata"] & {
        gitCommit?: { author?: { email?: string } };
      };
      if (metadata.gitCommit?.author?.email) authors.push(metadata.gitCommit.author.email);
      if (metadata.git) {
        if (Array.isArray(metadata.git.commits)) {
          for (const commit of metadata.git.commits) {
            if (commit.author?.email) authors.push(commit.author.email);
          }
        }
        if (authors.length === 0 && metadata.git.commit?.author?.email) {
          authors.push(metadata.git.commit.author.email);
        }
      }
      this.gitAuthors = Array.from(new Set(authors));
    }
  }

  onStdOut(
    chunk: string | Buffer,
    _: void | TestCase,
    __: void | TestResult
  ): void {
    if (this.options.quiet) {
      return;
    }

    const text = chunk.toString("utf-8");
    process.stdout.write(redactWebhookUrl(text, this.options.webhookUrl));
  }

  onStdErr(chunk: string | Buffer, _: TestCase, __: TestResult) {
    if (this.options.quiet) {
      return;
    }

    const text = chunk.toString("utf-8");
    process.stderr.write(redactWebhookUrl(text, this.options.webhookUrl));
  }

  async onEnd(result: FullResult) {
    let durationMs: number | undefined = undefined;
    if (this.options.enableDuration && this.startTime) {
      durationMs = Date.now() - this.startTime;
    }
    await processResults(this.suite, this.options, durationMs, this.gitAuthors, result.status);
  }
}
