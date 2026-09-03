import { describe, expect, it, vi } from "vitest";
import {
  appendRecordingEvent,
  applyTeachingDesktopInput,
  completeTeachingSession,
  emptyRecording,
  expireTaughtSkillTeaching,
  recordTeachingInputEvent,
} from "./teaching-session.js";

function skillRow(
  overrides: Partial<ReturnType<typeof emptySkill>> = {},
): ReturnType<typeof emptySkill> {
  return { ...emptySkill(), ...overrides };
}

function emptySkill() {
  return {
    id: "skill-1",
    spaceId: "workspace-1",
    botId: "bot-1",
    userId: "user-1",
    name: "",
    goal: "Export the list",
    status: "recording",
    playbook: {},
    recording: emptyRecording(),
    startedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    stoppedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function recordingDeps(skill: ReturnType<typeof skillRow>) {
  let current = structuredClone(skill);
  const tx = {
    $executeRaw: vi.fn(),
    taughtSkill: {
      findUniqueOrThrow: vi.fn(async () => current),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        current = { ...current, ...data };
        return current;
      }),
    },
    message: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: "message-1", blocks: [{ kind: "skill_draft", skillId: "skill-1" }] },
        ]),
    },
    bot: {
      findUnique: vi.fn(),
    },
    thread: {
      update: vi.fn(async () => ({ nextEventSeq: 2 })),
    },
    event: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "event-1",
        seq: 1,
        createdAt: new Date(),
        ...data,
      })),
    },
  };
  return {
    current: () => current,
    tx,
    deps: {
      prisma: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
        taughtSkill: {
          findUnique: vi.fn(async () => current),
          findFirst: vi.fn(async () => (current.status === "recording" ? current : null)),
        },
        bot: {
          findUnique: vi.fn(),
        },
        message: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: "message-1", blocks: [{ kind: "skill_draft", skillId: "skill-1" }] },
            ]),
        },
        event: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      },
      events: { append: vi.fn(), notify: vi.fn(), finalizeComputerControlRelease: vi.fn() },
      jobs: { enqueue: vi.fn(), cancel: vi.fn() },
      sandbox: { observe: vi.fn(), setScreenControl: vi.fn(), sendInput: vi.fn(), act: vi.fn() },
      home: {},
      dataDir: "/tmp",
    },
  };
}

describe("appendRecordingEvent", () => {
  it("keeps the same key pressed at different times", async () => {
    const { deps, current } = recordingDeps(skillRow());
    await appendRecordingEvent(deps as never, "skill-1", {
      at: "2026-01-01T00:00:00.000Z",
      kind: "key",
      key: "o",
    });
    await appendRecordingEvent(deps as never, "skill-1", {
      at: "2026-01-01T00:00:00.100Z",
      kind: "key",
      key: "o",
    });
    expect(current().recording.events).toHaveLength(2);
  });

  it("skips an exact duplicate event", async () => {
    const { deps, current } = recordingDeps(skillRow());
    const event = { at: "2026-01-01T00:00:00.000Z", kind: "key" as const, key: "o" };
    await appendRecordingEvent(deps as never, "skill-1", event);
    await appendRecordingEvent(deps as never, "skill-1", event);
    expect(current().recording.events).toHaveLength(1);
  });
});

describe("expireTaughtSkillTeaching", () => {
  it("leaves a live recording session untouched", async () => {
    const { deps } = recordingDeps(skillRow());
    const result = await expireTaughtSkillTeaching(deps as never, "skill-1");
    expect(result?.status).toBe("recording");
    expect(deps.jobs.cancel).not.toHaveBeenCalled();
  });

  it("retries leftover computer release after the session is already a draft", async () => {
    const { deps, tx } = recordingDeps(
      skillRow({
        status: "draft",
        expiresAt: new Date(Date.now() - 1000),
        recording: { ...emptyRecording(), controlLeaseId: "lease-1" },
      }),
    );
    const bot = {
      id: "bot-1",
      thread: { id: "thread-1" },
      computer: {
        id: "computer-1",
        homeKey: "bot-1",
        kind: "cloud",
        providerRef: "box-1",
        controlHolder: "user",
        controlBotId: "bot-1",
        controlLeaseId: "lease-1",
      },
    };
    deps.prisma.bot.findUnique = vi.fn().mockResolvedValue(bot);
    await expireTaughtSkillTeaching(deps as never, "skill-1");
    expect(deps.jobs.cancel).toHaveBeenCalledWith("computer.control-expire:computer-1:lease-1");
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "thread.message.created",
          payload: expect.objectContaining({ messageId: "message-1" }),
        }),
      }),
    );
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "skill.draft.created",
          payload: expect.objectContaining({ skillId: "skill-1" }),
        }),
      }),
    );
    expect(deps.events.notify).toHaveBeenCalled();
  });

  it("does not steal a later manual takeover when retrying a draft", async () => {
    const { deps } = recordingDeps(
      skillRow({
        status: "draft",
        recording: { ...emptyRecording(), controlLeaseId: "teach-lease" },
      }),
    );
    deps.prisma.bot.findUnique = vi.fn().mockResolvedValue({
      id: "bot-1",
      thread: { id: "thread-1" },
      computer: {
        id: "computer-1",
        homeKey: "bot-1",
        kind: "cloud",
        providerRef: "box-1",
        controlHolder: "user",
        controlBotId: "bot-1",
        controlLeaseId: "manual-lease",
      },
    });
    await expireTaughtSkillTeaching(deps as never, "skill-1");
    expect(deps.jobs.cancel).not.toHaveBeenCalled();
    expect(deps.events.finalizeComputerControlRelease).not.toHaveBeenCalled();
  });

  it("does not republish draft events once they already exist", async () => {
    const { deps, tx } = recordingDeps(skillRow({ status: "draft" }));
    deps.prisma.bot.findUnique = vi.fn().mockResolvedValue({
      id: "bot-1",
      thread: { id: "thread-1" },
      computer: null,
    });
    tx.event.findMany = vi.fn().mockResolvedValue([{ payload: { skillId: "skill-1" } }]);
    await expireTaughtSkillTeaching(deps as never, "skill-1");
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(deps.events.notify).not.toHaveBeenCalled();
  });
});

describe("completeTeachingSession", () => {
  it("publishes the stopped event atomically with finalization, once", async () => {
    const { deps, tx, current } = recordingDeps(skillRow());
    const bot = { id: "bot-1", thread: { id: "thread-1" }, computer: null };
    deps.prisma.bot.findUnique = vi.fn().mockResolvedValue(bot);
    tx.bot.findUnique = vi.fn().mockResolvedValue(bot);
    const actor = { spaceId: "workspace-1", userId: "user-1" } as never;

    await completeTeachingSession(deps as never, actor, "skill-1", "stopped");
    const stoppedEvents = () =>
      tx.event.create.mock.calls.filter(
        (call) => (call[0] as { data: { type: string } }).data.type === "skill.teaching.stopped",
      );
    expect(current().status).toBe("draft");
    expect(stoppedEvents()).toHaveLength(1);
    expect(deps.events.notify).toHaveBeenCalled();

    // A retry after the finalize commit must not lose or duplicate the stopped event.
    await completeTeachingSession(deps as never, actor, "skill-1", "stopped");
    expect(stoppedEvents()).toHaveLength(1);
  });
});

describe("recordTeachingInputEvent", () => {
  it("does not claim a click that landed after the session was finalized", async () => {
    const { deps } = recordingDeps(skillRow({ status: "draft" }));
    deps.prisma.taughtSkill.findFirst = vi
      .fn()
      .mockResolvedValue(skillRow({ status: "recording" }));
    const recorded = await recordTeachingInputEvent(
      deps as never,
      { spaceId: "workspace-1", userId: "user-1" } as never,
      "bot-1",
      { kind: "key", key: "x" },
    );
    expect(recorded).toBe("stale");
  });

  it("rejects input after the recording window", async () => {
    const { deps, current } = recordingDeps(skillRow({ expiresAt: new Date(Date.now() - 1000) }));
    const outcome = await recordTeachingInputEvent(
      deps as never,
      { spaceId: "workspace-1", userId: "user-1" } as never,
      "bot-1",
      { kind: "key", key: "x" },
    );
    expect(outcome).toBe("stale");
    expect(current().recording.events).toHaveLength(0);
  });

  it("applies input before persisting the recording", async () => {
    const { deps, current, tx } = recordingDeps(skillRow());
    const computer = {
      id: "computer-1",
      homeKey: "bot-1",
      kind: "e2b",
      providerRef: "box-1",
      controlHolder: "user",
      controlBotId: "bot-1",
      controlLeaseId: "lease-1",
    };
    const order: string[] = [];
    tx.taughtSkill.update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      order.push("persist");
      Object.assign(current(), data);
      return current();
    });
    tx.bot.findUnique = vi.fn(async () => ({ id: "bot-1", computer }));
    deps.sandbox.sendInput = vi.fn(async () => {
      order.push("send");
    });
    await expect(
      recordTeachingInputEvent(
        deps as never,
        { spaceId: "workspace-1", userId: "user-1" } as never,
        "bot-1",
        { kind: "pointer", x: 12, y: 40, button: "left", type: "click" },
      ),
    ).resolves.toBe("recorded");
    expect(order).toEqual(["send", "persist"]);
    expect(current().recording.events).toHaveLength(1);
  });

  it("records repeated identical inputs in the same millisecond", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const { deps, current, tx } = recordingDeps(skillRow());
      tx.bot.findUnique = vi.fn(async () => ({
        id: "bot-1",
        computer: {
          id: "computer-1",
          homeKey: "bot-1",
          kind: "e2b",
          providerRef: "box-1",
          controlHolder: "user",
          controlBotId: "bot-1",
          controlLeaseId: "lease-1",
        },
      }));
      const input = { kind: "key" as const, key: "o" };
      await expect(
        recordTeachingInputEvent(
          deps as never,
          { spaceId: "workspace-1", userId: "user-1" } as never,
          "bot-1",
          input,
        ),
      ).resolves.toBe("recorded");
      await expect(
        recordTeachingInputEvent(
          deps as never,
          { spaceId: "workspace-1", userId: "user-1" } as never,
          "bot-1",
          input,
        ),
      ).resolves.toBe("recorded");
      expect(deps.sandbox.sendInput).toHaveBeenCalledTimes(2);
      expect(current().recording.events).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not persist an event when sandbox input fails", async () => {
    const { deps, current, tx } = recordingDeps(skillRow());
    tx.bot.findUnique = vi.fn(async () => ({
      id: "bot-1",
      computer: {
        id: "computer-1",
        homeKey: "bot-1",
        kind: "e2b",
        providerRef: "box-1",
        controlHolder: "user",
        controlBotId: "bot-1",
        controlLeaseId: "lease-1",
      },
    }));
    deps.sandbox.sendInput = vi.fn(async () => {
      throw new Error("sandbox unavailable");
    });
    await expect(
      recordTeachingInputEvent(
        deps as never,
        { spaceId: "workspace-1", userId: "user-1" } as never,
        "bot-1",
        { kind: "key", key: "x" },
      ),
    ).rejects.toThrow("sandbox unavailable");
    expect(current().recording.events).toHaveLength(0);
  });
});

describe("applyTeachingDesktopInput", () => {
  const computer = {
    homeKey: "bot-1",
    kind: "e2b",
    providerRef: "box-1",
    controlLeaseId: "lease-1",
  };

  it("types printable characters that have no keysym", async () => {
    const sandbox = { sendInput: vi.fn(), act: vi.fn() };
    await applyTeachingDesktopInput(
      sandbox as never,
      computer,
      { kind: "key", key: " " },
      {} as never,
    );
    expect(sandbox.sendInput).toHaveBeenCalledWith(
      expect.anything(),
      { kind: "clipboard", text: " " },
      expect.anything(),
      expect.anything(),
    );
  });

  it("sends browser key names as X11 keysyms", async () => {
    const sandbox = { sendInput: vi.fn(), act: vi.fn() };
    await applyTeachingDesktopInput(
      sandbox as never,
      computer,
      { kind: "key", key: "ArrowLeft" },
      {} as never,
    );
    expect(sandbox.sendInput).toHaveBeenCalledWith(
      expect.anything(),
      { kind: "key", key: "Left" },
      expect.anything(),
      expect.anything(),
    );
  });

  it("leaves pointer input untouched", async () => {
    const sandbox = { sendInput: vi.fn(), act: vi.fn() };
    const pointer = {
      kind: "pointer" as const,
      x: 5,
      y: 6,
      button: "left" as const,
      type: "click" as const,
    };
    await applyTeachingDesktopInput(sandbox as never, computer, pointer, {} as never);
    expect(sandbox.sendInput).toHaveBeenCalledWith(
      expect.anything(),
      pointer,
      expect.anything(),
      expect.anything(),
    );
  });
});
