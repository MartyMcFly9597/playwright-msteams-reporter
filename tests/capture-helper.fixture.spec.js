const { expect, test: base } = require("@playwright/test");
const { captureEnvSignals } = require("../dist/healthCapture");

const existingTest = base.extend({
  existingFixture: async ({}, use) => use("preserved"),
});

const test = existingTest.extend({
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

test("capture composes with an existing CommonJS fixture", async ({ existingFixture, environmentEvidence }) => {
  expect(existingFixture).toBe("preserved");
  expect(environmentEvidence).toBeUndefined();
});