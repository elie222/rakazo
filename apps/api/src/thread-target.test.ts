import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { stopThreadRuns, type ThreadTarget } from "./thread-target.js";

describe("stopThreadRuns", () => {
  it("releases every active group member screen immediately", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-a", botId: "bot-a" },
          { id: "run-b", botId: "bot-b" },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      bot: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "bot-a",
            computer: { homeKey: "home-a", kind: "fake", providerRef: "computer-a" },
          },
          {
            id: "bot-b",
            computer: { homeKey: "home-b", kind: "fake", providerRef: "computer-b" },
          },
        ]),
      },
      computerExecutionLease: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      computer: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      event: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;
    const actor = {
      workspaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await stopThreadRuns(
      { prisma, sandbox: { releaseScreen } as unknown as SandboxProvider },
      actor,
      target,
    );

    expect(releaseScreen).toHaveBeenCalledTimes(2);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({ workspaceId: "workspace-1", userId: "user-1", botId: "bot-a" }),
    );
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-b" }),
      expect.objectContaining({ workspaceId: "workspace-1", userId: "user-1", botId: "bot-b" }),
    );
  });
});
