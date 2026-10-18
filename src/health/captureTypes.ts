/** Options controlling which browser events are retained as environment-signal annotations. */
export interface EnvSignalCaptureOptions {
  /** Annotation type prefix. Defaults to `env-signal:`. */
  annotationPrefix?: string;
  /** Allowed request hosts. Defaults to the fixture page host when available; otherwise no hosts are inferred. */
  includeHosts?: string[];
  /** Hosts excluded even when they are included by policy. */
  excludeHosts?: string[];
  /** URL paths excluded from capture. Entries must be absolute HTTP(S) URLs. */
  excludeUrls?: string[];
  /** HTTP response statuses treated as expected noise. Defaults to 401 and 403. */
  ignoredHttpStatuses?: number[];
  /** Maximum retained events across all kinds. Defaults to 20. */
  maxEvents?: number;
  /** Maximum retained events per signal kind. Defaults to 5. */
  maxEventsPerKind?: number;
  /** Maximum sanitized description length. Defaults to 300 characters. */
  maxDescriptionLength?: number;
  /** Retain captured annotations on passing tests. Defaults to false. */
  retainOnPass?: boolean;
  /** Classifies captured browser events. Return undefined to try the next classifier or built-in classification. */
  classifiers?: EnvSignalClassifier[];
  /** Optional domain-specific sanitizer; its output is sanitized again by the helper. */
  sanitizeText?: (text: string) => string;
}

/** Normalized browser event passed to configured signal classifiers. */
export interface EnvSignalCaptureEvent {
  /** Playwright event source used by built-in and custom classifiers. */
  source: "page-error" | "console-error" | "response" | "request-failed" | "manual" | "timeout";
  /** Associated request or page URL, when available. */
  url?: string;
  /** HTTP response status, when the source is a response. */
  status?: number;
  /** HTTP request method, when available. */
  method?: string;
  /** Playwright resource type, when available. */
  resourceType?: string;
  /** Sanitized source text supplied to classifiers before retained output sanitization. */
  text?: string;
}

/** Signal kind and optional description returned by a classifier or manual record call. */
export interface EnvSignalClassification {
  /** Short stable signal identifier used in the annotation type. */
  kind: string;
  /** Human-readable evidence detail; sanitized and clipped before retention. */
  description?: string;
}

/** Manually recorded signal, optionally scoped to a URL checked against capture policy. */
export interface EnvSignalRecord extends EnvSignalClassification {
  url?: string;
}

/** Maps a captured browser event to a signal, or returns undefined to defer classification. */
export type EnvSignalClassifier = (event: EnvSignalCaptureEvent) => EnvSignalClassification | undefined;

export interface NormalizedEnvSignalCaptureOptions {
  annotationPrefix: string;
  includeHosts: string[];
  excludeHosts: string[];
  excludeUrls: string[];
  ignoredHttpStatuses: number[];
  maxEvents: number;
  maxEventsPerKind: number;
  maxDescriptionLength: number;
  retainOnPass: boolean;
  classifiers: EnvSignalClassifier[];
  sanitizeText: ((text: string) => string) | undefined;
}