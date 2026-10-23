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

  it("reports a failed runner even when no suite began", async () => {
    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "1" });
    global.fetch = fetchMock;
    const reporter = new MsTeamsReporter({
      webhookUrl: "https://acme.example/webhook",
      notifyOnSuccess: false,
    });

    await reporter.onEnd({ status: "failed", duration: 1000 } as FullResult);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const card = JSON.parse(fetchMock.mock.calls[0][1].body).attachments[0].content;
    expect(card.body[0].items[1].text).toBe("Test run failed");
  });

  it("reports a failed runner when its suite has no tests", async () => {
    jest.spyOn(console, "log").mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "1" });
    global.fetch = fetchMock;
    const reporter = new MsTeamsReporter({ webhookUrl: "https://acme.example/webhook" });
    const emptySuite = { allTests: () => [], suites: [] } as unknown as Suite;

    reporter.onBegin({} as FullConfig, emptySuite);
    await reporter.onEnd({ status: "timedout", duration: 1000 } as FullResult);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the legacy single commit author when commits is empty", async () => {
    jest.spyOn(console, "log").mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "1" });
    global.fetch = fetchMock;
    const reporter = new MsTeamsReporter({
      webhookUrl: "https://acme.example/webhook",
      mentionAuthors: true,
    });
    const failedSuite = {
      allTests: () => [{}],
      suites: [{ allTests: () => [{ outcome: () => "unexpected" }] }],
    } as unknown as Suite;

    reporter.onBegin({ metadata: { git: { commits: [], commit: { author: { email: "legacy@acme.example" } } } } } as unknown as FullConfig, failedSuite);
    await reporter.onEnd({ status: "failed", duration: 1000 } as FullResult);

    const card = JSON.parse(fetchMock.mock.calls[0][1].body).attachments[0].content;
    expect(card.msteams.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "<at>legacy@acme.example</at>" }),
    ]));
  });

  it("keeps the failed-tests headline for ordinary test failures", async () => {
    jest.spyOn(console, "log").mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "1" });
    global.fetch = fetchMock;
    const reporter = new MsTeamsReporter({ webhookUrl: "https://acme.example/webhook" });
    const failedSuite = {
      allTests: () => [{}],
      suites: [{ allTests: () => [{ outcome: () => "unexpected" }] }],
    } as unknown as Suite;

    reporter.onBegin({} as FullConfig, failedSuite);
    await reporter.onEnd({ status: "failed", duration: 1000 } as FullResult);

    const card = JSON.parse(fetchMock.mock.calls[0][1].body).attachments[0].content;
    expect(card.body[0].items[1].text).toBe("Tests failed");
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