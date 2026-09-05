import { buildSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createAgentSkillsService } from "./agent-skills.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};

function savedInterrogate() {
  return {
    id: "saved-interrogate",
    spaceId: actor.spaceId,
    userId: actor.userId,
    name: "interrogate",
    description: "My existing recipe",
    content: buildSkillMd({
      name: "interrogate",
      description: "My existing recipe",
      body: "Keep this behavior.",
    }),
    source: "user",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  };
}

describe("agent skill builtins", () => {
  it("keeps a persisted same-name skill visible and preferred by name", async () => {
    const row = savedInterrogate();
    const prisma = {
      agentSkill: {
        findMany: vi.fn().mockResolvedValue([row]),
        findFirst: vi.fn().mockResolvedValue(row),
      },
    } as unknown as PrismaClient;
    const service = createAgentSkillsService(prisma);

    await expect(service.listWithContent(actor)).resolves.toEqual([
      expect.objectContaining({ id: row.id, source: "user" }),
    ]);
    await expect(service.get(actor, { name: "Interrogate" })).resolves.toMatchObject({
      id: row.id,
      source: "user",
      content: expect.stringContaining("Keep this behavior."),
    });
  });

  it("returns the builtin when no persisted skill owns its name", async () => {
    const prisma = {
      agentSkill: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaClient;
    const service = createAgentSkillsService(prisma);

    await expect(service.get(actor, { name: "interrogate" })).resolves.toMatchObject({
      id: "builtin:Interrogate",
      source: "builtin",
      readOnly: true,
    });
  });
});
