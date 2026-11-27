import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));

import type { Routine } from "@rakazo/contracts";
import {
  draftStateFromRoutine,
  emptyRoutineDraftState,
  emptyWatchDraft,
  watchFromDraft,
} from "./routine-draft";

describe("watchFromDraft", () => {
  it("splits paths by line and drops blanks", () => {
    const result = watchFromDraft({ ...emptyWatchDraft(), paths: " inbox/ \n\nreports/a.csv\n" });
    expect(result).toEqual({
      watch: { kind: "files", everyMinutes: 15, loud: false, paths: ["inbox/", "reports/a.csv"] },
    });
  });

  it("parses tool arguments as a JSON object", () => {
    const draft = { ...emptyWatchDraft(), kind: "tool" as const, tool: "brain_changed" };
    expect(watchFromDraft({ ...draft, args: '{"limit":1}' })).toMatchObject({
      watch: { tool: "brain_changed", args: { limit: 1 } },
    });
    expect(watchFromDraft({ ...draft, args: "[1]" })).toHaveProperty("error");
    expect(watchFromDraft({ ...draft, args: "{nope" })).toHaveProperty("error");
  });

  it("reads tracked fields as a comma list, only for a command or tool", () => {
    const tool = {
      ...emptyWatchDraft(),
      kind: "tool" as const,
      tool: "list_tasks",
      track: " id, date_updated ,",
    };
    expect(watchFromDraft(tool)).toMatchObject({ watch: { track: ["id", "date_updated"] } });
    expect(watchFromDraft({ ...tool, track: "" })).not.toHaveProperty("watch.track");
    const files = { ...emptyWatchDraft(), paths: "inbox/", track: "id" };
    expect(watchFromDraft(files)).not.toHaveProperty("watch.track");
  });

  it("refuses an empty watch", () => {
    expect(watchFromDraft(emptyWatchDraft())).toHaveProperty("error");
    expect(watchFromDraft({ ...emptyWatchDraft(), kind: "command" })).toHaveProperty("error");
  });
});

it("saves an HTTPS watch with its URL and tracked fields", () => {
  expect(
    watchFromDraft({
      ...emptyWatchDraft(),
      kind: "http",
      url: " https://example.com/status ",
      track: "id, updatedAt",
    }),
  ).toEqual({
    watch: {
      kind: "http",
      url: "https://example.com/status",
      track: ["id", "updatedAt"],
      everyMinutes: 15,
      loud: false,
    },
  });
  expect(
    watchFromDraft({ ...emptyWatchDraft(), kind: "http", url: "http://localhost" }),
  ).toHaveProperty("error");
});

it("leaves non-URL watch validation to the server, as other watch kinds do", () => {
  for (const invalid of [{ everyMinutes: 1 }, { track: "a,b,c,d,e,f" }]) {
    expect(
      watchFromDraft({
        ...emptyWatchDraft(),
        kind: "http",
        url: "https://example.com/status",
        ...invalid,
      }),
    ).toHaveProperty("watch");
  }
});

it("reads whether a routine runs in the chat", () => {
  const routine: Routine = {
    id: "routine-1",
    botId: "bot-1",
    name: "Digest",
    prompt: "Summarize the day.",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: true,
    inChat: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    emailSenders: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    watch: null,
    watchState: null,
    lastRunAt: null,
    nextRunAt: null,
    endsAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  expect(emptyRoutineDraftState().inChat).toBe(false);
  expect(draftStateFromRoutine(routine).inChat).toBe(true);
  expect(draftStateFromRoutine({ ...routine, inChat: false }).inChat).toBe(false);
});
