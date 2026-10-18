import type { BrowserContext, ConsoleMessage, Page, Request, Response, TestInfo } from "@playwright/test";
import { sanitizeHealthText } from "./render";
import { normalizeCaptureOptions } from "./captureOptions";
import type { EnvSignalCaptureEvent, EnvSignalCaptureOptions, EnvSignalRecord } from "./captureTypes";

export interface CaptureEnvSignalsOptions {
  page: Page;
  context: BrowserContext;
  testInfo: TestInfo;
  options?: EnvSignalCaptureOptions;
}

export interface EnvSignalCapture {
  record(event: EnvSignalRecord): void;
  dispose(): void;
}

interface RetainedSignal {
  kind: string;
  description: string;
}

interface IgnoredResponseToken {
  id: number;
  key: string;
  page?: Page;
  request?: Request;
  address: string;
  status: number;
  kind: "response" | "console";
  signal?: RetainedSignal;
  expiresAt: number;
  previous?: IgnoredResponseToken;
  next?: IgnoredResponseToken;
}

interface CorrelationQueue {
  responseHead?: IgnoredResponseToken;
  responseTail?: IgnoredResponseToken;
  consoleHead?: IgnoredResponseToken;
  consoleTail?: IgnoredResponseToken;
}

function isIntentionalCancellation(errorText: string): boolean {
  return /\b(?:ERR_ABORTED|ERR_CANCELED|ERR_CANCELLED|NS_BINDING_ABORTED)\b/i.test(errorText) ||
    /^(?:provisional )?navigation (?:was )?cancel(?:ed|led)\.?$/i.test(errorText.trim()) ||
    /^request (?:was )?cancel(?:ed|led)\.?$/i.test(errorText.trim());
}

function pageHost(page: Page, testInfo: TestInfo): string | undefined {
  try {
    const currentHost = new URL(page.url()).hostname;
    if (currentHost) return currentHost;
  } catch {
    // Fall back to the configured origin before the page's first navigation.
  }
  const baseURL = testInfo.project?.use?.baseURL;
  if (typeof baseURL !== "string") return undefined;
  try { return new URL(baseURL).hostname; } catch { return undefined; }
}

function consoleErrorText(message: ConsoleMessage): string {
  return message.text();
}

function safeKind(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
}

function cleanDescription(value: string, policy: ReturnType<typeof normalizeCaptureOptions>): string {
  return sanitizeHealthText(value, policy.maxDescriptionLength, undefined, policy.sanitizeText, false);
}

function isRelevantUrl(address: string | undefined, policy: ReturnType<typeof normalizeCaptureOptions>): boolean {
  if (!address) return true;
  try {
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (!policy.includeHosts.includes(host) || policy.excludeHosts.includes(host)) return false;
    return !policy.excludeUrls.some(exclusion => {
      const path = exclusion.slice(new URL(exclusion).origin.length);
      return url.origin === new URL(exclusion).origin &&
        (url.pathname === path || url.pathname.startsWith(path.endsWith("/") ? path : `${path}/`));
    });
  } catch {
    return false;
  }
}

export function captureEnvSignals({ page, context, testInfo, options = {} }: CaptureEnvSignalsOptions): EnvSignalCapture {
  const policy = normalizeCaptureOptions(options, pageHost(page, testInfo));
  const discoverFirstHost = options.includeHosts === undefined && policy.includeHosts.length === 0;
  const pages = new Set<Page>();
  const pageListeners = new Map<Page, {
    onPageError: (error: Error) => void;
    onConsole: (message: ConsoleMessage) => void;
    onClose: () => void;
  }>();
  const signals: RetainedSignal[] = [];
  const countsByKind = new Map<string, number>();
  const pageIds = new WeakMap<Page, number>();
  let nextPageId = 0;
  const correlationTokens = new Map<number, IgnoredResponseToken>();
  const responseQueues = new Map<string, CorrelationQueue>();
  let nextCorrelationTokenId = 0;
  let disposed = false;

  const cleanSignal = (kind: string, description = ""): RetainedSignal | undefined => {
    if (typeof kind !== "string") return undefined;
    const sanitizedKind = sanitizeHealthText(kind, 80, undefined, undefined, false);
    if (!safeKind(sanitizedKind)) return undefined;
    return { kind: sanitizedKind, description: cleanDescription(description, policy) };
  };

  const appendStoredSignal = (signal: RetainedSignal | undefined): void => {
    if (disposed || !signal) return;
    if (signals.length >= policy.maxEvents) return;
    const count = countsByKind.get(signal.kind) ?? 0;
    if (count >= policy.maxEventsPerKind) return;
    countsByKind.set(signal.kind, count + 1);
    signals.push(signal);
  };

  const appendSignal = (kind: string, description = ""): void => {
    appendStoredSignal(cleanSignal(kind, description));
  };

  const record = (event: EnvSignalRecord): void => {
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.kind !== "string" ||
      (event.url !== undefined && typeof event.url !== "string") ||
      (event.description !== undefined && typeof event.description !== "string") || !isRelevantUrl(event.url, policy)) return;
    appendSignal(event.kind, event.description ?? "");
  };

  const classify = (event: EnvSignalCaptureEvent): void => {
    if (disposed || !isRelevantUrl(event.url, policy) ||
      (event.status !== undefined && policy.ignoredHttpStatuses.includes(event.status))) return;
    for (const classifier of policy.classifiers) {
      try {
        const classification = classifier(event);
        if (classification) {
          appendSignal(
            classification.kind,
            typeof classification.description === "string" ? classification.description : event.text ?? ""
          );
          return;
        }
      } catch {
        continue;
      }
    }
    if (event.source === "page-error") appendSignal("page-error", event.text ?? "");
    else if (event.source === "console-error") appendSignal("console-error", event.text ?? "");
    else if (event.source === "response" && event.status !== undefined && event.status >= 500) {
      appendSignal("http-5xx", event.text ?? `HTTP ${event.status}`);
    } else if (event.source === "request-failed" && event.text && !isIntentionalCancellation(event.text)) {
      appendSignal("net-fail", event.text);
    }
  };

  const classifyConsoleDiagnostic = (url: string, text: string): RetainedSignal | undefined => {
    const event: EnvSignalCaptureEvent = { source: "console-error", url, text };
    for (const classifier of policy.classifiers) {
      try {
        const classification = classifier(event);
        if (classification) {
          return cleanSignal(
            classification.kind,
            typeof classification.description === "string" ? classification.description : text,
          ) ?? cleanSignal("console-error", text);
        }
      } catch {
        continue;
      }
    }
    return cleanSignal("console-error", text);
  };

  const responseKey = (target: Page | undefined, address: string, status: number): string => {
    if (!target) return JSON.stringify([null, status, address]);
    let pageId = pageIds.get(target);
    if (pageId === undefined) {
      pageId = nextPageId++;
      pageIds.set(target, pageId);
    }
    return JSON.stringify([pageId, status, address]);
  };

  const unlinkCorrelationToken = (token: IgnoredResponseToken): void => {
    const queue = responseQueues.get(token.key);
    if (!queue) return;
    const responseToken = token.kind === "response";
    const head = responseToken ? "responseHead" : "consoleHead";
    const tail = responseToken ? "responseTail" : "consoleTail";
    if (token.previous) token.previous.next = token.next;
    else queue[head] = token.next;
    if (token.next) token.next.previous = token.previous;
    else queue[tail] = token.previous;
    if (!queue.responseHead && !queue.consoleHead) responseQueues.delete(token.key);
    token.previous = undefined;
    token.next = undefined;
  };

  const removeCorrelationToken = (token: IgnoredResponseToken): void => {
    if (!correlationTokens.delete(token.id)) return;
    unlinkCorrelationToken(token);
  };

  const retainExpiredConsole = (token: IgnoredResponseToken): void => {
    if (token.kind === "console") appendStoredSignal(token.signal);
    removeCorrelationToken(token);
  };

  const pruneExpiredCorrelationTokens = (now: number): void => {
    while (true) {
      const oldest = correlationTokens.values().next().value as IgnoredResponseToken | undefined;
      if (!oldest || oldest.expiresAt > now) return;
      retainExpiredConsole(oldest);
    }
  };

  const addCorrelationToken = (
    target: Page | undefined,
    address: string,
    status: number,
    kind: IgnoredResponseToken["kind"],
    signal?: RetainedSignal,
    request?: Request,
  ): void => {
    if (kind === "console" && !isRelevantUrl(address, policy)) return;
    const now = Date.now();
    pruneExpiredCorrelationTokens(now);
    const maximumTokens = policy.maxEvents * 4;
    if (correlationTokens.size >= maximumTokens) {
      const oldest = correlationTokens.values().next().value as IgnoredResponseToken | undefined;
      if (oldest) retainExpiredConsole(oldest);
    }
    const key = responseKey(target, address, status);
    const queue = responseQueues.get(key) ?? {};
    const responseToken = kind === "response";
    const tail = responseToken ? queue.responseTail : queue.consoleTail;
    const token: IgnoredResponseToken = {
      id: nextCorrelationTokenId++, key, page: target, request, address, status, kind,
      signal: kind === "console" ? signal : undefined,
      expiresAt: now + 5000, previous: tail,
    };
    if (tail) tail.next = token;
    else if (responseToken) queue.responseHead = token;
    else queue.consoleHead = token;
    if (responseToken) queue.responseTail = token;
    else queue.consoleTail = token;
    responseQueues.set(key, queue);
    correlationTokens.set(token.id, token);
  };

  const belongsToPage = (token: IgnoredResponseToken, target: Page): boolean => {
    try {
      return token.request?.frame().page() === target;
    } catch {
      return false;
    }
  };

  const rebindResponseToken = (token: IgnoredResponseToken, target: Page): void => {
    const key = responseKey(target, token.address, token.status);
    const pendingConsole = responseQueues.get(key)?.consoleHead;
    if (pendingConsole) {
      removeCorrelationToken(token);
      removeCorrelationToken(pendingConsole);
      return;
    }
    unlinkCorrelationToken(token);
    token.page = target;
    token.key = key;
    const queue = responseQueues.get(key) ?? {};
    let next = queue.responseHead;
    while (next && next.id < token.id) next = next.next;
    if (next) {
      token.next = next;
      token.previous = next.previous;
      if (next.previous) next.previous.next = token;
      else queue.responseHead = token;
      next.previous = token;
    } else {
      token.previous = queue.responseTail;
      if (queue.responseTail) queue.responseTail.next = token;
      else queue.responseHead = token;
      queue.responseTail = token;
    }
    responseQueues.set(key, queue);
  };

  const bindPendingResponses = (target: Page): void => {
    pruneExpiredCorrelationTokens(Date.now());
    for (const token of correlationTokens.values()) {
      if (token.kind !== "response" || token.page || !token.request) continue;
      if (!belongsToPage(token, target)) continue;
      rebindResponseToken(token, target);
    }
  };

  const consumeCorrelationToken = (
    target: Page | undefined,
    address: string,
    status: number,
    kind: IgnoredResponseToken["kind"],
  ): IgnoredResponseToken | undefined => {
    pruneExpiredCorrelationTokens(Date.now());
    const queue = responseQueues.get(responseKey(target, address, status));
    const token = kind === "response" ? queue?.responseHead : queue?.consoleHead;
    if (!token) return undefined;
    removeCorrelationToken(token);
    return token;
  };

  const releasePage = (target: Page): void => {
    const listeners = pageListeners.get(target);
    if (!listeners) return;
    target.removeListener("pageerror", listeners.onPageError);
    target.removeListener("console", listeners.onConsole);
    target.removeListener("close", listeners.onClose);
    pageListeners.delete(target);
    pages.delete(target);
    for (const token of correlationTokens.values()) {
      if (token.page === target) retainExpiredConsole(token);
    }
  };

  const registerPage = (target: Page): void => {
    if (pages.has(target)) return;
    pages.add(target);
    const onPageError = (error: Error): void => classify({
      source: "page-error", url: target.url(), text: error?.message ?? String(error),
    });
    const onConsole = (message: ConsoleMessage): void => {
      if (message.type() !== "error") return;
      bindPendingResponses(target);
      const url = message.location().url || target.url();
      if (!isRelevantUrl(url, policy)) return;
      const text = consoleErrorText(message);
      const status = /^Failed to load resource:.*?status of\s+(\d{3})\b/i.exec(text)?.[1];
      if (status && policy.ignoredHttpStatuses.includes(Number(status))) {
        if (consumeCorrelationToken(target, url, Number(status), "response")) return;
        addCorrelationToken(target, url, Number(status), "console", classifyConsoleDiagnostic(url, text));
        return;
      }
      classify({ source: "console-error", url, text });
    };
    const onClose = (): void => releasePage(target);
    pageListeners.set(target, { onPageError, onConsole, onClose });
    target.on("pageerror", onPageError);
    target.on("console", onConsole);
    target.on("close", onClose);
  };
  const onPage = (target: Page): void => {
    registerPage(target);
    bindPendingResponses(target);
  };
  const onRequest = (request: Request): void => {
    if (!discoverFirstHost || policy.includeHosts.length || !request.isNavigationRequest()) return;
    try {
      const frame = request.frame();
      if (frame.parentFrame() || frame.page() !== page) return;
      const host = new URL(request.url()).hostname.toLowerCase();
      if (host && !policy.excludeHosts.includes(host)) policy.includeHosts.push(host);
    } catch {
      return;
    }
  };
  const onResponse = (response: Response): void => {
    const request = response.request();
    const address = response.url();
    const status = response.status();
    if (policy.ignoredHttpStatuses.includes(status) && isRelevantUrl(address, policy)) {
      let sourcePage: Page | undefined;
      try { sourcePage = request.frame().page(); } catch { /* Service-worker requests have no frame. */ }
      if (sourcePage) {
        if (!consumeCorrelationToken(sourcePage, address, status, "console")) {
          addCorrelationToken(sourcePage, address, status, "response", undefined, request);
        }
      } else if (!consumeCorrelationToken(undefined, address, status, "console")) {
        addCorrelationToken(undefined, address, status, "response", undefined, request);
      }
    }
    classify({
      source: "response", url: address, status,
      method: request.method(), resourceType: request.resourceType(), text: `HTTP ${status}`,
    });
  };
  const onRequestFailed = (request: Request): void => classify({
    source: "request-failed", url: request.url(), method: request.method(),
    resourceType: request.resourceType(), text: request.failure()?.errorText ?? "Request failed",
  });
  context.on("page", onPage);
  context.on("request", onRequest);
  context.on("response", onResponse);
  context.on("requestfailed", onRequestFailed);
  for (const existingPage of context.pages()) registerPage(existingPage);
  registerPage(page);

  const flushPendingDiagnostics = (): void => {
    for (const registeredPage of pages) bindPendingResponses(registeredPage);
    for (const token of correlationTokens.values()) {
      if (token.kind === "console") retainExpiredConsole(token);
    }
  };

  const removeListeners = (): void => {
    context.removeListener("page", onPage);
    context.removeListener("request", onRequest);
    context.removeListener("response", onResponse);
    context.removeListener("requestfailed", onRequestFailed);
    for (const registeredPage of pages) {
      releasePage(registeredPage);
    }
    pages.clear();
    pageListeners.clear();
    correlationTokens.clear();
    responseQueues.clear();
  };

  const appendAnnotations = (): void => {
    if (testInfo.status !== "passed" || policy.retainOnPass) {
      for (const signal of signals) {
        testInfo.annotations.push({
          type: `${policy.annotationPrefix}${signal.kind}`,
          ...(signal.description ? { description: signal.description } : {}),
        });
      }
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    if (testInfo.status === "timedOut" || (testInfo.timeout > 0 && testInfo.duration >= testInfo.timeout)) {
      appendSignal("test-timeout", "Test exceeded its configured time budget");
    }
    flushPendingDiagnostics();
    disposed = true;
    removeListeners();
    appendAnnotations();
  };

  return { record, dispose };
}