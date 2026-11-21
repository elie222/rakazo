import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { managesToolCallRecords } from "./spaces.js";

const actor = {
  userId: "user-fixture",
  spaceId: "space-fixture",
  email: "fixture@example.test",
  isDeploymentOwner: false,
};

function withRole(role: string | null) {
  const findUnique = vi.fn().mockResolvedValue(role === null ? null : { role });
  return { prisma: { spaceMember: { findUnique } } as unknown as PrismaClient, findUnique };
}

describe("who may change whether a Space keeps tool call details", () => {
  it("lets any owner of the Space decide, including one who did not create it", async () => {
    const { prisma, findUnique } = withRole("owner");
    await expect(managesToolCallRecords(prisma, actor)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
      select: { role: true },
    });
  });

  it("reads an owner role inside a list of roles", async () => {
    await expect(managesToolCallRecords(withRole("member, owner").prisma, actor)).resolves.toBe(
      true,
    );
  });

  it("refuses a plain member and someone outside the Space", async () => {
    await expect(managesToolCallRecords(withRole("member").prisma, actor)).resolves.toBe(false);
    await expect(managesToolCallRecords(withRole(null).prisma, actor)).resolves.toBe(false);
  });
});
