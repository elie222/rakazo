import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createRepos } from "./repos.js";

const actor: Actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  email: "test@example.com",
  isDeploymentOwner: false,
};

const baseBot = {
  id: "bot-1",
  workspaceId: "ws-1",
  userId: "user-1",
  name: "Test Bot",
  title: "",
  description: "",
  instructions: "",
  color: "#000",
  notifyOnFinish: true,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  parentBotId: null,
  memoryScope: null as string | null,
  createdAt: new Date("2026-08-19T00:00:00.000Z"),
  updatedAt: new Date("2026-08-19T00:00:00.000Z"),
  thread: { id: "thread-1", unread: false, messages: [] },
  runs: [],
  computer: null,
};

function reposFor(memoryScope: string | null) {
  const prisma = {
    bot: {
      findMany: vi.fn(async () => [{ ...baseBot, memoryScope }]),
    },
  };
  return createRepos(prisma as unknown as PrismaClient);
}

describe("createRepos.listBots", () => {
  it("passes memoryScope through as null when unset", async () => {
    await expect(reposFor(null).listBots(actor)).resolves.toEqual([
      expect.objectContaining({ memoryScope: null }),
    ]);
  });

  it("passes memoryScope through when set to shared", async () => {
    await expect(reposFor("shared").listBots(actor)).resolves.toEqual([
      expect.objectContaining({ memoryScope: "shared" }),
    ]);
  });
});
