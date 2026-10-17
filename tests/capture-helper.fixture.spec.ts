import { expect, test as base } from "@playwright/test";
import { captureEnvSignals } from "../dist/healthCapture";

const existingTest = base.extend<{ existingFixture: string }>({
  existingFixture: async ({}, use) => use("preserved"),
});

const test = existingTest.extend<{ environmentEvidence: void }>({
  environmentEvidence: async ({ page, context }, use, testInfo) => {
    const capture = captureEnvSignals({ page, context, testInfo, options: { retainOnPass: true } });
    try {
      capture.record({ kind: "fixture-composed", description: "synthetic fixture evidence" });
      await use(undefined);
    } finally {
      capture.dispose();
    }
    expect(testInfo.annotations.some(annotation => annotation.type === "env-signal:fixture-composed")).toBe(true);
  },
});

test("capture composes with an existing TypeScript fixture", async ({ existingFixture, environmentEvidence }) => {
  expect(existingFixture).toBe("preserved");
  expect(environmentEvidence).toBeUndefined();
});