import { createSpaceForMember, recordAuditEvent, SpaceLimitError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSpawnedBot } from "../../bots/child-bots.js";
import { publishMessage } from "../assembly/run-messages.js";
import { fleetTools } from "./run-tools-fleet.js";
import { SELF_ARCHIVED_NOTE } from "./run-tools-fleet.prompt.js";

// Creating a Space needs its tables; what this file checks is what the tool reports about it.
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createSpaceForMember: vi.fn(async (_prisma: unknown, input: { name: string }) => ({
    id: "space-2",
    name: input.name,
  })),
  recordAuditEvent: vi.fn(async () => undefined),
}));

function fakeRun() {
  const publishRosterChange = vi.fn(async () => undefined);
  const ctx = {
    deps: { prisma: {}, events: { publishRosterChange } },
    run: {
      id: "run-1",
      userId: "user-1",
      spaceId: "space-1",
      botId: "bot-1",
      threadId: "thread-1",
    },
    bot: { id: "bot-1", name: "Helper" },
  };
  const call = (args: Record<string, unknown>) =>
    fleetTools.create_space!(
      ctx as never,
      {
        name: "create_space",
        args,
        executionId: "call-1",
        finish: async (result: unknown) => result,
      } as never,
    );
  return { publishRosterChange, call };
}

vi.mock("../../bots/child-bots.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  archiveSpawnedBot: vi.fn(),
}));
vi.mock("../assembly/run-messages.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  publishMessage: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.mocked(recordAuditEvent).mockClear();
});

describe("create_space", () => {
  it("records the creation and tells the member's apps to re-read their Space list", async () => {
    const { publishRosterChange, call } = fakeRun();
    await expect(call({ name: "Support" })).resolves.toEqual({
      ok: true,
      spaceId: "space-2",
      name: "Support",
    });
    expect(recordAuditEvent).toHaveBeenCalledExactlyOnceWith({
      action: "space.created",
      actor: { type: "bot", id: "bot-1", label: "Helper" },
      spaceId: "space-2",
      target: { type: "space", id: "space-2", label: "Support" },
      runId: "run-1",
      threadId: "thread-1",
    });
    expect(publishRosterChange).toHaveBeenCalledExactlyOnceWith({ userIds: ["user-1"] });
  });

  it("records nothing when the Space is refused", async () => {
    const { publishRosterChange, call } = fakeRun();
    vi.mocked(createSpaceForMember).mockRejectedValueOnce(new SpaceLimitError());
    await expect(call({ name: "Support" })).resolves.toHaveProperty("error");
    expect(recordAuditEvent).not.toHaveBeenCalled();
    expect(publishRosterChange).not.toHaveBeenCalled();
  });
});

describe("archive_bot", () => {
  function archive(botId: string) {
    vi.mocked(archiveSpawnedBot).mockResolvedValueOnce({ ok: true, botId, name: "Scout" });
    const append = vi.fn(async () => undefined);
    const ctx = {
      deps: { prisma: {}, events: { append } },
      run: { id: "run-1", userId: "user-1", spaceId: "space-1", botId: "bot-1" },
      bot: { id: "bot-1", name: "Scout" },
      thread: { id: "thread-1" },
      context: {},
      state: {} as { selfArchived?: true },
    };
    const result = fleetTools.archive_bot!(
      ctx as never,
      {
        name: "archive_bot",
        args: { confirm_name: "Scout" },
        executionId: "call-1",
        finish: async (value: unknown) => value,
        persistEffectResult: async () => true,
      } as never,
    );
    return { result, append, state: ctx.state };
  }

  it("archives the asking bot itself and tells it to finish its reply", async () => {
    const { result, state } = archive("bot-1");
    await expect(result).resolves.toEqual({
      ok: true,
      botId: "bot-1",
      name: "Scout",
      note: SELF_ARCHIVED_NOTE,
    });
    expect(archiveSpawnedBot).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ spawnedByBotId: "bot-1", runId: "run-1" }),
      expect.anything(),
    );
    expect(publishMessage).toHaveBeenCalled();
    expect(state.selfArchived).toBe(true);
  });

  it("reports another bot's archive without the note", async () => {
    const { result, state } = archive("peer-1");
    await expect(result).resolves.toEqual({
      ok: true,
      botId: "peer-1",
      name: "Scout",
    });
    expect(state.selfArchived).toBeUndefined();
  });
});
