import type { FullConfig, FullResult, Reporter, Suite, TestError } from "@playwright/test/reporter";
import type { HealthReporterOptions } from "../healthReporter.js";

export type { ErrorPattern, HealthCategory, HealthReporterOptions } from "../healthReporter.js";

declare class HealthReporter implements Reporter {
  constructor(options?: HealthReporterOptions);
  printsToStdio(): boolean;
  onBegin(config: FullConfig, suite: Suite): void;
  onError(error: TestError): void;
  onEnd(result: FullResult): Promise<void>;
}

export default HealthReporter;