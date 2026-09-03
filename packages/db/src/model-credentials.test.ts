import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  findDefaultModelCredential,
  findModelCredential,
  newestModelCredentialOrder,
  selectSpaceModelPreference,
} from "./model-credentials.js";

describe("findDefaultModelCredential", () => {
  it("resolves the default from the active space preference", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { spaceModelPreference: { findFirst } } as unknown as PrismaClient;

    await findDefaultModelCredential(prisma, { userId: "user", spaceId: "space" });

    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: "user", spaceId: "space", isDefault: true },
      include: { credential: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
  });
});

describe("findModelCredential", () => {
  it("falls back to the newest user credential when the space has no preference", async () => {
    const preferenceFindFirst = vi.fn().mockResolvedValue(null);
    const credentialFindFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: credentialFindFirst },
    } as unknown as PrismaClient;

    await findModelCredential(prisma, { userId: "user", spaceId: "space" }, "xai");

    expect(preferenceFindFirst).toHaveBeenCalledWith({
      where: { userId: "user", spaceId: "space", credential: { provider: "xai" } },
      include: { credential: true },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    });
    expect(credentialFindFirst).toHaveBeenCalledWith({
      where: { userId: "user", provider: "xai" },
      orderBy: newestModelCredentialOrder,
    });
  });
});

describe("selectSpaceModelPreference", () => {
  it("clears only a different active default before selecting the credential", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const upsert = vi.fn().mockResolvedValue({ id: "preference" });
    const prisma = { spaceModelPreference: { updateMany, upsert } } as unknown as PrismaClient;

    await selectSpaceModelPreference(
      prisma,
      { userId: "user", spaceId: "space" },
      "credential",
      "model",
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user",
        spaceId: "space",
        isDefault: true,
        credentialId: { not: "credential" },
      },
      data: { isDefault: false },
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ isDefault: true, modelId: "model" }),
        update: { isDefault: true, modelId: "model" },
      }),
    );
  });
});
