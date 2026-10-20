import type { MsTeamsReporterOptions } from "..";
import { redactWebhookUrl } from "./redactWebhookUrl";
import { resolveWebhookTimeout } from "./resolveWebhookTimeout";

function diagnosticText(text: string, webhookUrl: string): string {
  return redactWebhookUrl(text, webhookUrl).replace(/[\r\n]+/g, " ").slice(0, 1000);
}

function failureReason(error: unknown): string {
  try {
    if (!(error instanceof Error)) return String(error);
    if ("cause" in error && error.cause instanceof Error) {
      return `${error.message}: ${error.cause.message}`;
    }
    return error.message;
  } catch {
    return "Unknown error";
  }
}

async function cancelResponseBody(response: Response, signal: AbortSignal): Promise<void> {
  if (!response.body) return;
  let removeAbortListener = (): void => {};
  const aborted = new Promise<void>(resolve => {
    const onAbort = (): void => resolve();
    if (signal.aborted) resolve();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
  });
  try {
    await Promise.race([response.body.cancel(), aborted]);
  } finally {
    removeAbortListener();
  }
}

export async function sendWebhookMessage(
  webhookUrl: string,
  body: string,
  options: MsTeamsReporterOptions
): Promise<void> {
  const timeoutMs = resolveWebhookTimeout(options.webhookTimeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let responseText: string | undefined;
  try {
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!response.ok || (options.debug && !options.quiet)) {
      responseText = await response.text();
    } else {
      await cancelResponseBody(response, controller.signal);
      if (controller.signal.aborted) throw new Error("Webhook delivery timed out during response cleanup");
    }
  } catch (error) {
    const reason = controller.signal.aborted
      ? `Webhook delivery timed out after ${timeoutMs}ms`
      : failureReason(error);
    console.error("Failed to send message");
    if (options.debug) console.error(diagnosticText(reason, webhookUrl));
    return;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    console.error("Failed to send message");
    if (options.debug) console.error(diagnosticText(responseText ?? "", webhookUrl));
    return;
  }
  if (!options.debug || options.quiet) return;
  console.log("Message sent successfully");
  if (responseText && responseText !== "1") console.log(diagnosticText(responseText, webhookUrl));
}