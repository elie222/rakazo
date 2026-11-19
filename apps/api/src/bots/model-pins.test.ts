import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { modelDisconnectPreview } from "./model-pins.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

type Role = { role: string; position: number };

function fixture(input: {
  connections: string[];
  accountRoles?: Role[];
  spaceRoles?: Role[];
  bots?: string[];
  routines?: string[];
}) {
  const named = (names: string[] = []) => vi.fn(async () => names.map((name) => ({ name })));
  const prisma = {
    userModelCredential: {
      findMany: vi.fn(async () => input.connections.map((id) => ({ id }))),
    },
    userModelRoleChoice: { findMany: vi.fn(async () => input.accountRoles ?? []) },
    spaceModelRoleChoice: { findMany: vi.fn(async () => input.spaceRoles ?? []) },
    bot: { findMany: named(input.bots) },
    routine: { findMany: named(input.routines) },
  };
  const preview = (credentialId: string) =>
    modelDisconnectPreview({ prisma } as unknown as RouterDeps, actor, {
      provider: "provider-a",
      credentialId,
    });
  return { prisma, preview };
}

describe("modelDisconnectPreview", () => {
  it("names the member's bots and routines when the provider's last connection goes", async () => {
    const { prisma, preview } = fixture({
      connections: ["only"],
      accountRoles: [{ role: "main", position: 0 }],
      bots: ["Inbox", "Scout"],
      routines: ["Morning digest", "Inbox"],
    });

    await expect(preview("only")).resolves.toEqual({
      mainModel: true,
      backupModel: false,
      usedBy: ["Inbox", "Scout", "Morning digest"],
    });
    // The legacy rows without a funding pin ran on the last connection, so they count too.
    expect(prisma.userModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ credentialId: "only" }, { credentialId: null, creditOfferingId: null }],
        }),
      }),
    );
    expect(prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", modelProvider: "provider-a", archivedAt: null },
      }),
    );
  });

  it("names no bot while another connection of the provider still serves them", async () => {
    const { prisma, preview } = fixture({
      connections: ["personal", "work"],
      spaceRoles: [{ role: "main", position: 1 }],
      bots: ["Inbox"],
    });

    await expect(preview("work")).resolves.toEqual({
      mainModel: false,
      backupModel: true,
      usedBy: [],
    });
    expect(prisma.bot.findMany).not.toHaveBeenCalled();
    expect(prisma.routine.findMany).not.toHaveBeenCalled();
    expect(prisma.spaceModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ credentialId: "work" }] }),
      }),
    );
  });

  it("reports nothing for a connection that is not the member's", async () => {
    const { prisma, preview } = fixture({ connections: ["mine"], bots: ["Inbox"] });

    await expect(preview("someone-elses")).resolves.toEqual({
      mainModel: false,
      backupModel: false,
      usedBy: [],
    });
    expect(prisma.bot.findMany).not.toHaveBeenCalled();
  });
});
