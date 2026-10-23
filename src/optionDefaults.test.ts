import type { FullConfig, FullResult, Suite } from "@playwright/test/reporter";
import MsTeamsReporter from "./index";

describe("reporter option defaults", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => "1" });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("uses defaults when optional values are explicitly undefined", async () => {
    const reporter = new MsTeamsReporter({
      webhookUrl: "https://acme.example/webhook",
      notifyOnSuccess: undefined,
      webhookType: undefined,
      title: undefined,
      linkToResultsText: undefined,
      linkToResultsUrl: "https://acme.example/results",
    });
    const suite = {
      allTests: () => [{}],
      suites: [{ allTests: () => [{ outcome: () => "expected" }] }],
    } as unknown as Suite;

    reporter.onBegin({} as FullConfig, suite);
    await reporter.onEnd({ status: "passed" } as FullResult);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const card = JSON.parse(jest.mocked(global.fetch).mock.calls[0][1]!.body as string).attachments[0].content;
    expect(card.version).toBe("1.4");
    expect(card.body[0].items[0].text).toBe("Playwright Test Results");
    expect(card.actions[0].title).toBe("View test results");
  });

  it("rejects unsupported webhook types at construction", () => {
    expect(() => new MsTeamsReporter({ webhookType: "PowerAutomate" as any }))
      .toThrow("webhookType must be either msteams or powerautomate");
  });
});