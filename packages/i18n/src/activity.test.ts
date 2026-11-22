import { i18n } from "@lingui/core";
import type { RunActivityRow } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { messages as germanMessages } from "../locales/de/messages.po";
import {
  activityPreview,
  formatRelativeTime,
  routineRunLateLabel,
  runStatusLabel,
} from "./activity";

function german() {
  i18n.load("de", germanMessages);
  i18n.activate("de");
}

afterEach(() => i18n.activate("en"));

describe("formatRelativeTime", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  it.each([
    { seconds: 0, label: "just now" },
    { seconds: 59.999, label: "just now" },
    { seconds: 60, label: "1m ago" },
    { seconds: 3_599, label: "59m ago" },
    { seconds: 3_600, label: "1h ago" },
    { seconds: 86_400, label: "1d ago" },
  ])("formats $seconds seconds ago as $label", ({ seconds, label }) => {
    const iso = new Date(now.getTime() - seconds * 1_000).toISOString();
    expect(formatRelativeTime(iso, "en", now)).toBe(label);
  });

  it("includes the year only for older calendar years, in the given locale", () => {
    const now = new Date(2026, 5, 15, 12);
    const previous = new Date(2025, 0, 15, 12);
    const current = new Date(2026, 0, 15, 12);
    expect(formatRelativeTime(previous.toISOString(), "en", now)).toBe("Jan 15, 2025");
    expect(formatRelativeTime(current.toISOString(), "en", now)).toBe("Jan 15");
    expect(formatRelativeTime(previous.toISOString(), "de", now)).toBe(
      previous.toLocaleDateString("de", { day: "numeric", month: "short", year: "numeric" }),
    );
  });

  it("keeps recent dates relative across a local year boundary", () => {
    const date = new Date(2025, 11, 31, 23, 30);
    const cutoff = date.getTime() + 7 * 86_400_000;
    expect(formatRelativeTime(date.toISOString(), "en", new Date(cutoff - 1))).toBe("6d ago");
    expect(formatRelativeTime(date.toISOString(), "en", new Date(cutoff))).toBe("Dec 31, 2025");
  });

  it("leaves an unreadable time blank", () => {
    expect(formatRelativeTime("not a time", "en", now)).toBe("");
  });
});

describe("activityPreview", () => {
  it("composes translated activity labels, including empty text and sender fallbacks", () => {
    const run = {
      trigger: "bot_message" as const,
      promptSnippet: "Legacy English label",
      agentMessage: { fromBotName: "Maya", kind: "update" as const, text: "Ready" },
    };
    const preview = (overrides = {}) =>
      activityPreview({
        runId: "run",
        botId: "bot",
        botName: "Helper",
        groupId: null,
        groupName: null,
        threadId: "thread",
        status: "completed",
        notificationsEnabled: false,
        updatedAt: "2026-01-01T00:00:00Z",
        ...run,
        ...overrides,
      });
    expect(preview()).toBe("Update from Maya: Ready");
    german();
    expect(preview()).toBe("Update von Maya: Ready");
    expect(preview({ agentMessage: { fromBotName: "Maya", kind: "update", text: "" } })).toBe(
      "Update von Maya",
    );
    expect(preview({ agentMessage: { fromBotName: " ", kind: "request", text: "Ready" } })).toBe(
      "Ein anderer Agent fragt: Ready",
    );
    expect(preview({ agentMessage: { fromBotName: " ", kind: "request", text: "" } })).toBe(
      "Ein anderer Agent fragt",
    );
    expect(preview({ agentMessage: { fromBotName: "Maya", kind: "request", text: "Ready" } })).toBe(
      "Maya fragt: Ready",
    );
    expect(preview({ agentMessage: null, promptSnippet: "" })).toBe("");
    expect(preview({ agentMessage: { kind: "unknown" } })).toBe(
      "Nachricht von einem anderen Agenten",
    );
  });

  it("preserves composed snippets from older servers without agentMessage", () => {
    const run = { trigger: "bot_message", promptSnippet: "Maya asked: Ready" } as RunActivityRow;
    expect(activityPreview(run)).toBe("Maya asked: Ready");
    expect(activityPreview({ ...run, promptSnippet: "" })).toBe("");
    expect(activityPreview({ ...run, trigger: "user", agentMessage: null })).toBe(
      "Maya asked: Ready",
    );
  });
});

describe("routineRunLateLabel", () => {
  const run = {
    id: "run-1",
    botId: "bot-1",
    groupId: null,
    status: "completed" as const,
    error: null,
    createdAt: "2026-01-02T12:00:00Z",
    startedAt: "2026-01-02T12:00:00Z",
    lateSince: null,
    completedAt: "2026-01-02T12:01:00Z",
    messageId: null,
  };

  it("labels only a run that started late, in the active language", () => {
    expect(routineRunLateLabel(run)).toBeUndefined();
    expect(routineRunLateLabel({ ...run, lateSince: "2026-01-02T11:40:00Z" })).toBe(
      "Started 20m late",
    );
    expect(routineRunLateLabel({ ...run, lateSince: "2026-01-02T09:30:00Z" })).toBe(
      "Started 2h late",
    );
    german();
    expect(routineRunLateLabel({ ...run, lateSince: "2025-12-30T12:00:00Z" })).toBe(
      "3 T. verspätet gestartet",
    );
  });
});

it("names each run status", () => {
  expect(runStatusLabel("leased")).toBe("Starting");
  expect(runStatusLabel("waiting_takeover")).toBe("Needs takeover");
  expect(runStatusLabel("completed")).toBe("Done");
});
