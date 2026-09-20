import { describe, expect, it, vi } from "vitest";
import { resolveNextArtifactVersion } from "./artifact-versions.js";
import type { PrismaClient } from "./client.js";

const params = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  name: "Q3 Content Calendar",
};

describe("resolveNextArtifactVersion", () => {
  it("starts a new family at version 1 when nothing matches", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { artifact: { findFirst } } as unknown as Pick<PrismaClient, "artifact">;

    const result = await resolveNextArtifactVersion(prisma, params);

    expect(result).toEqual({ rootArtifactId: null, version: 1 });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          groupId: null,
          name: { equals: "Q3 Content Calendar", mode: "insensitive" },
        }),
      }),
    );
  });

  it("versions off the root when the only prior match is itself the root", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "artifact-root",
      rootArtifactId: null,
      version: 1,
    });
    const prisma = { artifact: { findFirst } } as unknown as Pick<PrismaClient, "artifact">;

    const result = await resolveNextArtifactVersion(prisma, params);

    expect(result).toEqual({ rootArtifactId: "artifact-root", version: 2 });
  });

  it("keeps pointing at the same root for a later version, not the previous version's own id", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "artifact-v2",
      rootArtifactId: "artifact-root",
      version: 2,
    });
    const prisma = { artifact: { findFirst } } as unknown as Pick<PrismaClient, "artifact">;

    const result = await resolveNextArtifactVersion(prisma, params);

    expect(result).toEqual({ rootArtifactId: "artifact-root", version: 3 });
  });

  it("matches by name case-insensitively and scopes to the group when given one", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { artifact: { findFirst } } as unknown as Pick<PrismaClient, "artifact">;

    await resolveNextArtifactVersion(prisma, { ...params, groupId: "group-1" });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ groupId: "group-1" }),
      }),
    );
  });
});
