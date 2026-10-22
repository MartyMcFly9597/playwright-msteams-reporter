import type { Suite } from "@playwright/test/reporter";
import type { MsTeamsReporterOptions } from ".";
import { processResults } from "./processResults";

describe("result link callback receivers", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it.each(["expected", "unexpected"])("preserves the options receiver and action order for %s outcomes", async (outcome) => {
    jest.spyOn(console, "log").mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "1" });
    global.fetch = fetchMock;
    const receivers: MsTeamsReporterOptions[] = [];
    const options: MsTeamsReporterOptions = {
      webhookUrl: "https://acme.example/webhook",
      notifyOnSuccess: true,
      linkToResultsText: "results",
      linkTextOnFailure: "failure",
      linkToResultsUrl() {
        receivers.push(this);
        return `https://acme.example/${this.linkToResultsText}`;
      },
      linkUrlOnFailure() {
        receivers.push(this);
        return `https://acme.example/${this.linkTextOnFailure}`;
      },
    };
    const suite = {
      allTests: () => [{}],
      suites: [{ allTests: () => [{ outcome: () => outcome }] }],
    } as unknown as Suite;

    await processResults(suite, options);

    expect(receivers).toHaveLength(outcome === "unexpected" ? 2 : 1);
    for (const receiver of receivers) expect(receiver).toBe(options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const actions = JSON.parse(fetchMock.mock.calls[0][1].body).attachments[0].content.actions;
    expect(actions).toEqual([
      { type: "Action.OpenUrl", title: "results", url: "https://acme.example/results" },
      ...(outcome === "unexpected"
        ? [{ type: "Action.OpenUrl", title: "failure", url: "https://acme.example/failure" }]
        : []),
    ]);
  });

  it.each([
    "relative/path",
    "   ",
    "javascript:alert(1)",
    "https://acme.example/undefined/undefined/actions/runs/undefined",
  ])("omits invalid results links returned as %s", async (invalidUrl) => {
    jest.spyOn(console, "log").mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "1" });
    global.fetch = fetchMock;
    const suite = {
      allTests: () => [{}],
      suites: [{ allTests: () => [{ outcome: () => "unexpected" }] }],
    } as unknown as Suite;

    await processResults(suite, {
      webhookUrl: "https://acme.example/webhook",
      linkToResultsUrl: () => invalidUrl,
      linkUrlOnFailure: () => invalidUrl,
    });

    const actions = JSON.parse(fetchMock.mock.calls[0][1].body).attachments[0].content.actions;
    expect(actions).toEqual([]);
    expect(JSON.stringify(actions)).not.toContain(invalidUrl);
  });

  it("preserves valid URLs containing an undefined path segment across link options", async () => {
    jest.spyOn(console, "log").mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "1" });
    global.fetch = fetchMock;
    const validUrl = "https://docs.acme.example/js/undefined/index.html";
    const suite = {
      allTests: () => [{}],
      suites: [{ allTests: () => [{ outcome: () => "unexpected" }] }],
    } as unknown as Suite;

    await processResults(suite, {
      webhookUrl: "https://acme.example/webhook",
      linkToResultsUrl: validUrl,
      linkToResultsText: "results",
      linkUrlOnFailure: validUrl,
      links: [{ text: "docs", url: validUrl }],
    });

    const actions = JSON.parse(fetchMock.mock.calls[0][1].body).attachments[0].content.actions;
    expect(actions).toEqual([
      { type: "Action.OpenUrl", title: "results", url: validUrl },
      { type: "Action.OpenUrl", title: "docs", url: validUrl },
      { type: "Action.OpenUrl", title: "View failed tests", url: validUrl },
    ]);
  });

  it("defaults a missing primary results action title when processResults is called directly", async () => {
    jest.spyOn(console, "log").mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "1" });
    global.fetch = fetchMock;
    const suite = {
      allTests: () => [{}],
      suites: [{ allTests: () => [{ outcome: () => "expected" }] }],
    } as unknown as Suite;

    await processResults(suite, {
      webhookUrl: "https://acme.example/webhook",
      notifyOnSuccess: true,
      linkToResultsUrl: "https://docs.acme.example/results",
    });

    const actions = JSON.parse(fetchMock.mock.calls[0][1].body).attachments[0].content.actions;
    expect(actions[0].title).toBe("View test results");
  });

  it("omits a primary results action with an empty title", async () => {
    jest.spyOn(console, "log").mockImplementation();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "1" });
    global.fetch = fetchMock;
    const suite = {
      allTests: () => [{}],
      suites: [{ allTests: () => [{ outcome: () => "expected" }] }],
    } as unknown as Suite;

    await processResults(suite, {
      webhookUrl: "https://acme.example/webhook",
      notifyOnSuccess: true,
      linkToResultsUrl: "https://docs.acme.example/results",
      linkToResultsText: "   ",
    });

    const actions = JSON.parse(fetchMock.mock.calls[0][1].body).attachments[0].content.actions;
    expect(actions).toEqual([]);
  });
});