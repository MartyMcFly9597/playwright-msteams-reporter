import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import type { Link, MsTeamsReporterOptions } from "../index.js";

export type { Link, MsTeamsReporterOptions } from "../index.js";

declare class MsTeamsReporter implements Reporter {
  constructor(options?: MsTeamsReporterOptions);
  onBegin(config: FullConfig, suite: Suite): void;
  onStdOut(chunk: string | Buffer, test?: void | TestCase, result?: void | TestResult): void;
  onStdErr(chunk: string | Buffer, test: TestCase, result: TestResult): void;
  onEnd(result: FullResult): Promise<void>;
}

export default MsTeamsReporter;