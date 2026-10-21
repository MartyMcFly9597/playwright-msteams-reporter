import { Suite } from "@playwright/test/reporter";
import { MsTeamsReporterOptions } from ".";
import {
  createTableRow,
  getMentions,
  getNotificationBackground,
  getNotificationColor,
  getNotificationTitle,
  getTotalStatus,
} from "./utils";
import { BaseAdaptiveCard, BaseTable } from "./constants";
import { redactWebhookUrl } from "./utils/redactWebhookUrl";
import type { AdaptiveCard, TestStatuses } from "./models";
import { resolveWebhookTimeout } from "./utils/resolveWebhookTimeout";
import { sendWebhookMessage } from "./utils/sendWebhookMessage";

function buildResultsTable(
  totalStatus: TestStatuses,
  totalTests: number,
  options: MsTeamsReporterOptions,
  durationMs?: number
) {
  const table = structuredClone(BaseTable);
  table.rows.push(
    createTableRow("Type", "Total"),
    createTableRow(
      `${options.enableEmoji ? "✅ " : ""}Passed`,
      totalStatus.passed,
      { style: "good" }
    )
  );
  if (totalStatus.flaky) {
    table.rows.push(
      createTableRow(
        `${options.enableEmoji ? "⚠️ " : ""}Flaky`,
        totalStatus.flaky,
        { style: "warning" }
      )
    );
  }
  table.rows.push(
    createTableRow(
      `${options.enableEmoji ? "❌ " : ""}Failed`,
      totalStatus.failed,
      { style: "attention" }
    ),
    createTableRow(
      `${options.enableEmoji ? "⏭️ " : ""}Skipped`,
      totalStatus.skipped,
      { style: "accent" }
    ),
    createTableRow("Total tests", totalTests, {
      isSubtle: true,
      weight: "Bolder",
    })
  );

  if (options.enableDuration && typeof durationMs === "number") {
    const seconds = Math.round(durationMs / 1000);
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    const durationStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
    table.rows.push(
      createTableRow("Duration", durationStr, {
        isSubtle: true,
        weight: "Bolder",
      })
    );
  }
  return table;
}

function addFailureMentions(
  adaptiveCard: AdaptiveCard,
  container: { items: any[] },
  options: MsTeamsReporterOptions,
  gitAuthors?: string[]
) {
  const mentionEmails = options.mentionAuthors && gitAuthors && gitAuthors.length > 0
    ? gitAuthors.join(",")
    : options.mentionOnFailure;
  const mentionData = getMentions(mentionEmails, options.mentionOnFailureText);
  if (!mentionData?.message || mentionData.mentions.length === 0) return;
  container.items.push({
    type: "TextBlock",
    size: "Medium",
    text: mentionData.message,
    wrap: true,
  });
  adaptiveCard.msteams.entities = mentionData.mentions.map((mention) => ({
    type: "mention",
    text: `<at>${mention.email}</at>`,
    mentioned: { id: mention.email, name: mention.name },
  }));
}

function addResultsLink(
  adaptiveCard: AdaptiveCard,
  link: string | (() => string) | undefined,
  title: string | undefined,
  options: MsTeamsReporterOptions
) {
  if (!link) return;
  const url = resolveLinkUrl(link, options);
  if (url) {
    adaptiveCard.actions.push({ type: "Action.OpenUrl", title, url });
  }
}

function resolveLinkUrl(
  link: string | (() => string),
  options: MsTeamsReporterOptions,
): string | undefined {
  let url: unknown;
  if (typeof link === "string") url = link;
  else if (typeof link === "function") url = link.call(options);
  else return undefined;
  if (typeof url !== "string" || !url.trim()) return undefined;
  try {
    const parsedUrl = new URL(url);
    if ((parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
      parsedUrl.pathname.split("/").some((segment) => segment.toLowerCase() === "undefined")) return undefined;
    return parsedUrl.href;
  } catch {
    return undefined;
  }
}

function addReportLinks(adaptiveCard: AdaptiveCard, options: MsTeamsReporterOptions, isSuccess: boolean) {
  addResultsLink(adaptiveCard, options.linkToResultsUrl, options.linkToResultsText, options);
  for (const link of options.links ?? []) {
    if (!link || typeof link.text !== "string" || !link.text.trim() || !link.url) continue;
    const url = resolveLinkUrl(link.url, options);
    if (url) adaptiveCard.actions.push({ type: "Action.OpenUrl", title: link.text, url });
  }
  if (!isSuccess && options.linkUrlOnFailure) {
    const failureLinkText = options.linkTextOnFailure ?? "View failed tests";
    if (failureLinkText.trim()) {
      addResultsLink(adaptiveCard, options.linkUrlOnFailure, failureLinkText, options);
    }
  }
}

function logSkippedReport(message: string, options: MsTeamsReporterOptions) {
  if (!options.quiet) console.log(message);
}

export const processResults = async (
  suite: Suite | undefined,
  options: MsTeamsReporterOptions,
  durationMs?: number,
  gitAuthors?: string[]
) => {
  resolveWebhookTimeout(options.webhookTimeoutMs);
  if (!options.webhookUrl) {
    console.error("No webhook URL provided");
    return;
  }
  if (!suite) {
    console.error("No test suite found");
    return;
  }
  if (options.shouldRun && !options.shouldRun(suite)) return;
  const totalTests = suite.allTests().length;
  if (!options.reportOnEmpty && totalTests === 0) {
    logSkippedReport("No tests found, skipping report (reportOnEmpty is false)", options);
    return;
  }
  const adaptiveCard = structuredClone(BaseAdaptiveCard);
  const totalStatus = getTotalStatus(suite.suites);
  const isSuccess = totalStatus.failed === 0;
  if (isSuccess && !options.notifyOnSuccess) {
    logSkippedReport("No failed tests, skipping notification", options);
    return;
  }
  const table = buildResultsTable(totalStatus, totalTests, options, durationMs);

  const container = {
    type: "Container",
    items: [
      {
        type: "TextBlock",
        size: "ExtraLarge",
        weight: "Bolder",
        text: options.title,
      },
      {
        type: "TextBlock",
        size: "Large",
        weight: "Bolder",
        text: getNotificationTitle(totalStatus),
        color: getNotificationColor(totalStatus),
      },
      table,
    ] as any[],
    bleed: true,
    backgroundImage: {
      url: getNotificationBackground(totalStatus),
      fillMode: "RepeatHorizontally",
    },
  };

  if (!isSuccess) {
    addFailureMentions(adaptiveCard, container, options, gitAuthors);
  }

  // Add the container to the body
  adaptiveCard.body.push(container);

  addReportLinks(adaptiveCard, options, isSuccess);

  if (options.webhookType === "powerautomate") {
    adaptiveCard.version = "1.4";
  }

  const body = JSON.stringify({
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: adaptiveCard,
      },
    ],
  });

  if (options.debug) {
    console.log("Sending the following message:");
    console.log(redactWebhookUrl(body, options.webhookUrl));
  }

  await sendWebhookMessage(options.webhookUrl, body, options);
};
