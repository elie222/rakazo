import type { PrismaClient } from "@rakazo/db";
import { requireMembership } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { actorFromMembership } from "./app.js";

const actor = {
  userId: "user-1",
  spaceId: "space-support",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

function prisma(options: {
  membership: boolean;
  settings?: () => Promise<{ ownerUserId: string } | null>;
}) {
  return {
    spaceMember: {
      findFirst: vi.fn(async () =>
        options.membership
          ? {
              userId: actor.userId,
              spaceId: actor.spaceId,
              member: { user: { email: actor.email } },
            }
          : null,
      ),
    },
    deploymentSettings: {
      findUnique: vi.fn(options.settings ?? (async () => ({ ownerUserId: "someone-else" }))),
    },
  } as unknown as PrismaClient;
}

describe("actorFromMembership", () => {
  it("returns no actor when the user is not a member of the requested Space", async () => {
    await expect(
      actorFromMembership(
        requireMembership(prisma({ membership: false }), "user-1", "space-other"),
      ),
    ).resolves.toBeNull();
  });

  it("returns the actor for a real membership", async () => {
    await expect(
      actorFromMembership(
        requireMembership(prisma({ membership: true }), "user-1", "space-support"),
      ),
    ).resolves.toEqual(actor);
  });

  it("lets a deployment-settings failure surface instead of looking signed out", async () => {
    const failure = new Error("database unavailable");
    await expect(
      actorFromMembership(
        requireMembership(
          prisma({
            membership: true,
            settings: async () => {
              throw failure;
            },
          }),
          "user-1",
          "space-support",
        ),
      ),
    ).rejects.toBe(failure);
  });
});
