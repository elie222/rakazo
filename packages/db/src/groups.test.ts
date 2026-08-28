import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createGroupRepos } from "./groups.js";

describe("createGroupRepos.archiveGroup", () => {
  it("locks the group and cancels its runs in the archive transaction", async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => {
        order.push("lock");
        return [{ id: "group-1" }];
      }),
      chatGroup: {
        findFirst: vi.fn(async () => ({ thread: { id: "thread-1" } })),
        update: vi.fn(async () => order.push("archive")),
      },
      run: {
        findMany: vi.fn(async () => [{ id: "run-1" }]),
        updateMany: vi.fn(async () => order.push("cancel")),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { workspaceId: "workspace-1", userId: "user-1" } as Actor;

    await expect(createGroupRepos(prisma).archiveGroup(actor, "group-1")).resolves.toEqual([
      "run-1",
    ]);
    expect(order).toEqual(["lock", "cancel", "archive"]);
  });
});
