import { describe, expect, it, vi } from "vitest";
import { resolveNextArtifactVersion, withResolvedArtifactVersion } from "./artifact-versions.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

function versionConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

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

describe("withResolvedArtifactVersion", () => {
  it("resolves once and returns the attempt's result when there's no conflict", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { artifact: { findFirst } } as unknown as Pick<PrismaClient, "artifact">;
    const attempt = vi.fn().mockResolvedValue("created-row");

    const result = await withResolvedArtifactVersion(prisma, params, attempt);

    expect(result).toBe("created-row");
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith({ rootArtifactId: null, version: 1 });
  });

  it("re-resolves and retries on a version-uniqueness conflict, seeing the winner's row", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "artifact-root", rootArtifactId: null, version: 1 });
    const prisma = { artifact: { findFirst } } as unknown as Pick<PrismaClient, "artifact">;
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(versionConflict())
      .mockResolvedValueOnce("row-v2");

    const result = await withResolvedArtifactVersion(prisma, params, attempt);

    expect(result).toBe("row-v2");
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenNthCalledWith(1, { rootArtifactId: null, version: 1 });
    expect(attempt).toHaveBeenNthCalledWith(2, { rootArtifactId: "artifact-root", version: 2 });
  });

  it("propagates a non-conflict error without retrying", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { artifact: { findFirst } } as unknown as Pick<PrismaClient, "artifact">;
    const boom = new Error("storage put failed");
    const attempt = vi.fn().mockRejectedValue(boom);

    await expect(withResolvedArtifactVersion(prisma, params, attempt)).rejects.toBe(boom);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting its retry budget on persistent conflicts", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { artifact: { findFirst } } as unknown as Pick<PrismaClient, "artifact">;
    const attempt = vi.fn().mockRejectedValue(versionConflict());

    await expect(withResolvedArtifactVersion(prisma, params, attempt)).rejects.toThrow(
      "Unique constraint failed",
    );
    expect(attempt).toHaveBeenCalledTimes(5);
  });
});
