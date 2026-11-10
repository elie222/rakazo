import type { Routine } from "@rakazo/contracts";
import { defaultCronPreset, draftFromRoutine, emptyRoutineDraft } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { routineDraftChanged, routineSaveRequest } from "./routine-draft";

vi.mock("./i18n", () => ({ t: (message: string) => message }));

const routine: Routine = {
  id: "routine-1",
  botId: "bot-1",
  name: "Inbox",
  prompt: "Summarize my inbox.\n",
  crons: ["0 9 * * 1-5"],
  timezone: "Europe/Berlin",
  active: true,
  notify: true,
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
  createdAt: "2026-11-01T00:00:00.000Z",
};

describe("routineSaveRequest", () => {
  it("creates a routine with the device zone and its schedules", () => {
    const draft = {
      ...emptyRoutineDraft(),
      name: " Inbox ",
      prompt: "Summarize.",
      schedules: [defaultCronPreset()],
    };
    expect(routineSaveRequest(draft, null, "bot-1", "Asia/Tokyo")).toEqual({
      create: {
        botId: "bot-1",
        name: "Inbox",
        prompt: "Summarize.",
        crons: ["0 9 * * *"],
        timezone: "Asia/Tokyo",
        active: true,
        notify: true,
      },
    });
  });

  it("asks for a name, an instruction and a trigger before saving", () => {
    const named = { ...emptyRoutineDraft(), name: "Inbox" };
    expect(routineSaveRequest(emptyRoutineDraft(), null, "bot-1", "UTC")).toEqual({
      error: "name",
    });
    expect(routineSaveRequest(named, null, "bot-1", "UTC")).toEqual({ error: "prompt" });
    expect(routineSaveRequest({ ...named, prompt: "Go." }, null, "bot-1", "UTC")).toEqual({
      error: "trigger",
    });
  });

  it("finds nothing to save in a routine that was only opened", () => {
    expect(routineSaveRequest(draftFromRoutine(routine), routine, "bot-1", "UTC")).toEqual({
      unchanged: true,
    });
  });

  it("sends only the fields that changed", () => {
    const draft = { ...draftFromRoutine(routine), active: false };
    expect(routineSaveRequest(draft, routine, "bot-1", "UTC")).toEqual({
      update: { routineId: "routine-1", active: false },
    });
  });

  it("turns a routine silent, and back, without resending what did not change", () => {
    const draft = { ...draftFromRoutine(routine), silent: true };
    expect(routineSaveRequest(draft, routine, "bot-1", "UTC")).toEqual({
      update: { routineId: "routine-1", silent: true },
    });
    const silent = { ...routine, silent: true };
    expect(draftFromRoutine(silent).silent).toBe(true);
    expect(routineSaveRequest(draftFromRoutine(silent), silent, "bot-1", "UTC")).toEqual({
      unchanged: true,
    });
    expect(
      routineSaveRequest({ ...draftFromRoutine(silent), silent: false }, silent, "bot-1", "UTC"),
    ).toEqual({ update: { routineId: "routine-1", silent: false } });
  });

  it("creates a silent routine only when asked", () => {
    const draft = {
      ...emptyRoutineDraft(),
      name: "Tidy",
      prompt: "Archive done tickets.",
      schedules: [defaultCronPreset()],
      silent: true,
    };
    expect(routineSaveRequest(draft, null, "bot-1", "UTC")).toMatchObject({
      create: { silent: true },
    });
  });

  it("keeps a webhook as the only trigger once the last schedule goes", () => {
    const hooked = { ...routine, webhookEnabled: true };
    const draft = { ...draftFromRoutine(hooked), schedules: [] };
    expect(routineSaveRequest(draft, hooked, "bot-1", "UTC")).toEqual({
      update: { routineId: "routine-1", crons: [] },
    });
    expect(routineSaveRequest(draft, routine, "bot-1", "UTC")).toEqual({ error: "trigger" });
  });

  it("creates and changes an email trigger, and needs a trigger once it goes", () => {
    const draft = {
      ...emptyRoutineDraft(),
      name: "Mail",
      prompt: "File it.",
      emailSenders: "owner" as const,
    };
    expect(routineSaveRequest(draft, null, "bot-1", "UTC")).toMatchObject({
      create: { crons: [], emailSenders: "owner" },
    });

    const mailed = { ...routine, crons: [], emailSenders: "owner" as const };
    const widened = { ...draftFromRoutine(mailed), emailSenders: "domain" as const };
    expect(routineSaveRequest(widened, mailed, "bot-1", "UTC")).toEqual({
      update: { routineId: "routine-1", emailSenders: "domain" },
    });
    const removed = { ...draftFromRoutine(mailed), emailSenders: null };
    expect(routineSaveRequest(removed, mailed, "bot-1", "UTC")).toEqual({ error: "trigger" });
  });

  it("removes a trigger set up on web, and needs another once the last one goes", () => {
    const hooked = { ...routine, crons: [], webhookEnabled: true, githubEnabled: true };
    const opened = draftFromRoutine(hooked);
    expect(
      routineSaveRequest({ ...opened, webhookEnabled: false }, hooked, "bot-1", "UTC"),
    ).toEqual({ update: { routineId: "routine-1", webhookEnabled: false } });
    expect(
      routineSaveRequest(
        { ...opened, webhookEnabled: false, githubEnabled: false },
        hooked,
        "bot-1",
        "UTC",
      ),
    ).toEqual({ error: "trigger" });
  });

  it("never rewrites a one-shot's schedule", () => {
    const once = { ...routine, crons: ["@once"] };
    const draft = { ...draftFromRoutine(once), name: "Call Dana" };
    expect(routineSaveRequest(draft, once, "bot-1", "UTC")).toEqual({
      update: { routineId: "routine-1", name: "Call Dana" },
    });
  });
});

describe("routineDraftChanged", () => {
  it("counts an opened routine as unchanged even when it could not be saved as is", () => {
    const bare = { ...routine, crons: [] };
    expect(routineDraftChanged(draftFromRoutine(bare), bare)).toBe(false);
    expect(routineDraftChanged({ ...draftFromRoutine(bare), name: "Mail" }, bare)).toBe(true);
  });

  it("counts a new routine as changed once anything is filled in", () => {
    expect(routineDraftChanged(emptyRoutineDraft(), null)).toBe(false);
    expect(routineDraftChanged({ ...emptyRoutineDraft(), prompt: "Go." }, null)).toBe(true);
  });
});
