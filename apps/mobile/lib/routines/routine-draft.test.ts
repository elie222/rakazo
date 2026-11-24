import type { Routine } from "@rakazo/contracts";
import { defaultCronPreset, draftFromRoutine, emptyRoutineDraft, routineCopy } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { routineDraftChanged, routineSaveRequest } from "./routine-draft";

const routine: Routine = {
  id: "routine-1",
  botId: "bot-1",
  name: "Inbox",
  prompt: "Summarize my inbox.\n",
  crons: ["0 9 * * 1-5"],
  timezone: "Europe/Berlin",
  active: true,
  notify: true,
  inChat: false,
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
  createdAt: "2026-11-01T00:00:00.000Z",
};

describe("routineSaveRequest", () => {
  it("clears the end when an email trigger is added, which takes no end", () => {
    const ending = { ...routine, endsAt: "2031-11-30T17:00:00.000Z" };
    const draft = draftFromRoutine(ending);
    expect(routineSaveRequest({ ...draft, emailSenders: "owner" }, ending, "bot-1", "UTC")).toEqual(
      { update: { routineId: ending.id, emailSenders: "owner", endsAt: null } },
    );
  });

  it("sends an end only when its day changes, and on a new routine as that day ends", () => {
    const ending = { ...routine, endsAt: "2031-11-30T17:00:00.000Z" };
    const draft = draftFromRoutine(ending);
    expect(routineSaveRequest({ ...draft, name: "Mail" }, ending, "bot-1", "UTC")).toEqual({
      update: { routineId: ending.id, name: "Mail" },
    });
    expect(routineSaveRequest({ ...draft, endsOn: "" }, ending, "bot-1", "UTC")).toEqual({
      update: { routineId: ending.id, endsAt: null },
    });
    const created = routineSaveRequest(
      { ...draftFromRoutine(routine), endsOn: "2031-12-24" },
      null,
      "bot-1",
      "Europe/Berlin",
    );
    expect("create" in created && created.create.endsAt).toBe("2031-12-24T22:59:59.999Z");
  });

  it("sends Use my computer only when the owner flips it, and never to a copy", () => {
    const own = { ...routine, useComputer: false };
    const draft = draftFromRoutine(own);
    expect(routineSaveRequest({ ...draft, name: "Mail" }, own, "bot-1", "UTC")).toEqual({
      update: { routineId: own.id, name: "Mail" },
    });
    // Turning it on approves the prompt shown, so it goes with it.
    expect(routineSaveRequest({ ...draft, useComputer: true }, own, "bot-1", "UTC")).toEqual({
      update: { routineId: own.id, useComputer: true, prompt: own.prompt },
    });
    expect(
      routineSaveRequest(
        { ...draft, useComputer: false },
        { ...own, useComputer: true },
        "bot-1",
        "UTC",
      ),
    ).toEqual({ update: { routineId: own.id, useComputer: false } });
    // A routine the server doesn't offer it for never sends it.
    expect(
      routineSaveRequest(
        { ...draftFromRoutine(routine), useComputer: true },
        routine,
        "bot-1",
        "UTC",
      ),
    ).toEqual({ unchanged: true });
    // Nor with an email trigger, which the server refuses it for.
    expect(
      routineSaveRequest(
        { ...draft, emailSenders: "owner", useComputer: true },
        own,
        "bot-1",
        "UTC",
      ),
    ).toEqual({ update: { routineId: own.id, emailSenders: "owner" } });
    const copy = routineSaveRequest({ ...draft, useComputer: true }, null, "bot-1", "UTC", {
      ...own,
      useComputer: true,
    });
    expect("create" in copy && copy.create).not.toHaveProperty("useComputer");
  });

  it("approves again the prompt shown when a save edits it while Use my computer is on", () => {
    const own = { ...routine, useComputer: true };
    const draft = draftFromRoutine(own);
    expect(routineSaveRequest({ ...draft, prompt: " Twice " }, own, "bot-1", "UTC")).toEqual({
      update: { routineId: own.id, prompt: "Twice", useComputer: true },
    });
    expect(routineSaveRequest({ ...draft, active: !own.active }, own, "bot-1", "UTC")).toEqual({
      update: { routineId: own.id, active: !own.active },
    });
  });

  it("creates a paused copy that keeps the triggers it can't show, but not the model", () => {
    const hooked = {
      ...routine,
      crons: [],
      webhookEnabled: true,
      inChat: true,
      notify: false,
      modelProvider: "openai-compatible",
      modelId: "model-1",
    };
    const copy = routineCopy(hooked, "Inbox (copy)")!;
    expect(routineSaveRequest(draftFromRoutine(copy), null, "bot-1", "UTC", copy)).toEqual({
      create: expect.objectContaining({
        name: "Inbox (copy)",
        active: false,
        crons: [],
        webhookEnabled: true,
        inChat: true,
        notify: false,
      }),
    });
    expect(
      routineSaveRequest(draftFromRoutine(copy), null, "bot-1", "UTC", copy),
    ).not.toHaveProperty("create.modelId");
    // Removing the only trigger still asks for one.
    const unhooked = { ...draftFromRoutine(copy), webhookEnabled: false };
    expect(routineSaveRequest(unhooked, null, "bot-1", "UTC", copy)).toEqual({ error: "trigger" });
    // A one-time routine is only set up from chat, so it has no copy.
    expect(routineCopy({ ...routine, crons: ["@once"] }, "Once (copy)")).toBeNull();
  });

  it("creates a copy in the zone of the routine it copies, not the device's", () => {
    const copy = routineCopy({ ...routine, timezone: "America/New_York" }, "Inbox (copy)")!;
    expect(
      routineSaveRequest(draftFromRoutine(copy), null, "bot-1", "Australia/Sydney", copy),
    ).toEqual({ create: expect.objectContaining({ timezone: "America/New_York" }) });
  });

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

  it("preserves an HTTP watch when editing its routine from mobile", () => {
    const watched: Routine = {
      ...routine,
      crons: [],
      watch: { kind: "http", url: "https://example.com/status", everyMinutes: 5, loud: false },
    };
    const opened = draftFromRoutine(watched);
    expect(routineSaveRequest({ ...opened, name: "Status" }, watched, "bot-1", "UTC")).toEqual({
      update: { routineId: "routine-1", name: "Status" },
    });
    expect(routineSaveRequest({ ...opened, watch: null }, watched, "bot-1", "UTC")).toEqual({
      error: "trigger",
    });
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
