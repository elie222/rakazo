import { t } from "@lingui/core/macro";
import type { RunActivityRow } from "@rakazo/contracts";
import { activityPreview } from "@rakazo/i18n/activity";
import { describe, expect, it, vi } from "vitest";
import {
  activityFiltersActive,
  clearActivityFilterField,
  emptyActivityFilters,
  filterActivityRuns,
  runMatchesActivityFilters,
} from "./activity-list-filters";

vi.mock("@lingui/core/macro", () => ({
  t: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values)),
}));

function row(overrides: Partial<RunActivityRow> = {}): RunActivityRow {
  return {
    runId: "run_1",
    botId: "bot_1",
    botName: "Chief",
    groupId: null,
    groupName: null,
    threadId: "thread_1",
    status: "completed",
    trigger: "user",
    notificationsEnabled: false,
    agentMessage: null,
    promptSnippet: "summarize inbox",
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

describe("filterActivityRuns", () => {
  it("composes agent message labels through the translator and searches the visible preview", () => {
    const run = row({
      trigger: "bot_message",
      agentMessage: { fromBotName: "Maya", kind: "update", text: "Ready" },
      promptSnippet: "Legacy English label",
    });
    vi.mocked(t).mockClear();
    expect(activityPreview(run)).toBe("Update from Maya: Ready");
    expect(
      runMatchesActivityFilters(run, {
        ...emptyActivityFilters(),
        query: "Update from Maya: Ready",
      }),
    ).toBe(true);
    expect(
      activityPreview({ ...run, agentMessage: { fromBotName: "Maya", kind: "update", text: "" } }),
    ).toBe("Update from Maya");
    expect(
      activityPreview({
        ...run,
        agentMessage: { fromBotName: " ", kind: "request", text: "Ready" },
      }),
    ).toBe("Another agent asked: Ready");
    expect(
      activityPreview({ ...run, agentMessage: { fromBotName: " ", kind: "request", text: "" } }),
    ).toBe("Another agent asked");
    expect(activityPreview({ ...run, agentMessage: null, promptSnippet: "" })).toBe("");
    expect(activityPreview({ ...run, agentMessage: { kind: "unknown" } })).toBe(
      "Message from another agent",
    );
  });
  it("searches the translated preview rather than a server label", () => {
    const run = row({
      trigger: "bot_message",
      agentMessage: { fromBotName: "Maya", kind: "request", text: "Ready" },
      promptSnippet: "Legacy English label",
    });
    vi.mocked(
      t as (strings: TemplateStringsArray, ...values: unknown[]) => string,
    ).mockImplementationOnce((strings, ...values) =>
      String.raw(strings, ...values).replace(" asked:", " fragt:"),
    );
    expect(runMatchesActivityFilters(run, { ...emptyActivityFilters(), query: "Maya fragt" })).toBe(
      true,
    );
  });

  it("preserves composed snippets from older servers without agentMessage", () => {
    const run = row({ trigger: "bot_message", promptSnippet: "Maya asked: Ready" });
    Reflect.deleteProperty(run, "agentMessage");
    expect(activityPreview(run)).toBe("Maya asked: Ready");
    expect(activityPreview({ ...run, promptSnippet: "" })).toBe("");
  });

  it("matches the displayed group title and either name", () => {
    const run = row({
      botName: "Chief",
      groupName: "Ops",
      agentMessage: null,
      promptSnippet: "standby",
    });
    const filters = (query: string) => ({ ...emptyActivityFilters(), query });
    expect(runMatchesActivityFilters(run, filters("Chief Ops"))).toBe(true);
    expect(runMatchesActivityFilters(run, filters("Chief Ops"))).toBe(true);
    expect(runMatchesActivityFilters(run, filters("Chief"))).toBe(true);
    expect(runMatchesActivityFilters(run, filters("Ops"))).toBe(true);
    expect(runMatchesActivityFilters(run, filters("missing"))).toBe(false);
  });

  it("matches bot name and prompt in search", () => {
    const runs = [row(), row({ botName: "Scout", agentMessage: null, promptSnippet: "other" })];
    const filtered = filterActivityRuns(runs, {
      ...emptyActivityFilters(),
      query: "inbox",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.botName).toBe("Chief");
  });

  it("matches equivalent accent spellings in bot, group, and preview search", () => {
    const runs = [
      row({ runId: "bot", botName: "CAF\u00C9 Desk" }),
      row({ runId: "group", groupName: "Cafe\u0301 Team" }),
      row({ runId: "prompt", promptSnippet: "Review CAFE\u0301 today" }),
      row({
        runId: "agent",
        trigger: "bot_message",
        agentMessage: { fromBotName: "Maya", kind: "update", text: "Caf\u00E9 is ready" },
      }),
      row({ runId: "unrelated", botName: "Cafeteria" }),
    ];
    const matchingIds = (query: string) =>
      filterActivityRuns(runs, { ...emptyActivityFilters(), query }).map((run) => run.runId);
    expect.soft(matchingIds("  cafe\u0301  ")).toEqual(["bot", "group", "prompt", "agent"]);
    expect(matchingIds("CAF\u00C9")).toEqual(["bot", "group", "prompt", "agent"]);
  });

  it("keeps different accents and unaccented text distinct", () => {
    const run = row({ botName: "CAF\u00C9 Desk" });
    const matches = (query: string) =>
      runMatchesActivityFilters(run, { ...emptyActivityFilters(), query });
    expect(matches("  caf\u00E9 d  ")).toBe(true);
    expect(matches("cafe")).toBe(false);
    expect(matches("caf\u00E8")).toBe(false);
  });

  it("normalizes sequences that become composable only after lowercasing", () => {
    const run = row({ botName: "J\u030C Notes" });
    expect(runMatchesActivityFilters(run, { ...emptyActivityFilters(), query: "\u01F0" })).toBe(
      true,
    );
  });

  it("filters by status and date range", () => {
    const runs = [
      row({ status: "failed", updatedAt: "2026-09-01T10:00:00.000Z" }),
      row({ status: "completed", updatedAt: "2026-09-21T10:00:00.000Z" }),
    ];
    const filters = {
      ...emptyActivityFilters(),
      status: "completed" as const,
      dateRange: { from: "2026-09-15", to: "2026-09-22" },
    };
    expect(filterActivityRuns(runs, filters)).toHaveLength(1);
    expect(runMatchesActivityFilters(runs[1]!, filters)).toBe(true);
  });

  it("reads a date range whose From is after its To as the range between them", () => {
    const filters = {
      ...emptyActivityFilters(),
      dateRange: { from: "2026-09-20", to: "2026-09-01" },
    };
    expect(runMatchesActivityFilters(row({ updatedAt: "2026-09-10T10:00:00.000Z" }), filters)).toBe(
      true,
    );
    expect(runMatchesActivityFilters(row({ updatedAt: "2026-08-25T10:00:00.000Z" }), filters)).toBe(
      false,
    );
    expect(runMatchesActivityFilters(row({ updatedAt: "2026-09-25T10:00:00.000Z" }), filters)).toBe(
      false,
    );
  });

  it("keeps a search match when the timestamp is unreadable and no date is set", () => {
    const run = row({ updatedAt: "not-a-date" });
    expect(runMatchesActivityFilters(run, { ...emptyActivityFilters(), query: "inbox" })).toBe(
      true,
    );
    expect(
      runMatchesActivityFilters(run, {
        ...emptyActivityFilters(),
        dateRange: { from: "2026-09-01", to: "" },
      }),
    ).toBe(false);
  });

  it("clears individual filter fields", () => {
    const filters = {
      ...emptyActivityFilters(),
      query: "chief",
      status: "running" as const,
      dateRange: { from: "2026-09-01", to: "2026-09-02" },
    };
    expect(activityFiltersActive(filters)).toBe(true);
    const cleared = clearActivityFilterField(clearActivityFilterField(filters, "query"), "from");
    expect(cleared.query).toBe("");
    expect(cleared.dateRange.from).toBe("");
    expect(cleared.status).toBe("running");
  });
});
