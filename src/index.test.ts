import type { FullConfig, FullResult, Suite } from "@playwright/test/reporter";
import { Images } from "./constants";
import MsTeamsReporter from "./index";

describe("MsTeamsReporter lifecycle", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it.each([
    ["failed", "Test run failed"],
    ["timedout", "Test run timed out"],
    ["interrupted", "Test run interrupted"],
  ] as const)("reports a %s run as non-passing", async (status, expectedTitle) => {
    jest.spyOn(console, "log").mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "1" });
    global.fetch = fetchMock;
    const reporter = new MsTeamsReporter({
      webhookUrl: "https://acme.example/webhook",
      notifyOnSuccess: false,
    });
    const suite = {
      allTests: () => [{}],
      suites: [{ allTests: () => [{ outcome: () => "expected" }] }],
    } as unknown as Suite;

    reporter.onBegin({} as FullConfig, suite);
    await reporter.onEnd({ status, duration: 1000 } as FullResult);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const card = JSON.parse(fetchMock.mock.calls[0][1].body).attachments[0].content;
    expect(card.body[0].items[1]).toEqual(expect.objectContaining({ text: expectedTitle, color: "Attention" }));
    expect(card.body[0].backgroundImage.url).toBe(Images.failed);
  });

  it("mentions the current commit author from Playwright gitCommit metadata", async () => {
    jest.spyOn(console, "log").mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "1" });
    global.fetch = fetchMock;
    const reporter = new MsTeamsReporter({
      webhookUrl: "https://acme.example/webhook",
      mentionAuthors: true,
    });
    const suite = {
      allTests: () => [{}],
      suites: [{ allTests: () => [{ outcome: () => "unexpected" }] }],
    } as unknown as Suite;

    reporter.onBegin({ metadata: { gitCommit: { author: { email: "author@acme.example" } } } } as unknown as FullConfig, suite);
    await reporter.onEnd({ status: "failed", duration: 1000 } as FullResult);

    const card = JSON.parse(fetchMock.mock.calls[0][1].body).attachments[0].content;
    expect(card.msteams.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "<at>author@acme.example</at>" }),
    ]));
  });
});