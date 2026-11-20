import { createSpaceForMember, recordAuditEvent, SpaceLimitError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fleetTools } from "./run-tools-fleet.js";

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
