import type { RunActivityRow } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  activityFiltersActive,
  clearActivityFilterField,
  emptyActivityFilters,
  filterActivityRuns,
  runMatchesActivityFilters,
} from "./activity-list-filters.js";

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
    promptSnippet: "summarize inbox",
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

describe("filterActivityRuns", () => {
  it("matches bot name and prompt in search", () => {
    const runs = [row(), row({ botName: "Scout", promptSnippet: "other" })];
    const filtered = filterActivityRuns(runs, {
      ...emptyActivityFilters(),
      query: "inbox",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.botName).toBe("Chief");
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
