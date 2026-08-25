import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  findDefaultModelCredential,
  findModelCredential,
  newestModelCredentialOrder,
} from "./model-credentials.js";

describe("findDefaultModelCredential", () => {
  it("uses the same deterministic newest-first selection for every caller", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { userModelCredential: { findFirst } } as unknown as PrismaClient;

    await findDefaultModelCredential(prisma, { userId: "user", workspaceId: "workspace" });

    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: "user", workspaceId: "workspace", isDefault: true },
      orderBy: newestModelCredentialOrder,
    });
  });
});

describe("findModelCredential", () => {
  it("selects the newest credential for a provider in the workspace", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { userModelCredential: { findFirst } } as unknown as PrismaClient;

    await findModelCredential(prisma, { userId: "user", workspaceId: "workspace" }, "xai");

    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: "user", workspaceId: "workspace", provider: "xai" },
      orderBy: newestModelCredentialOrder,
    });
  });
});
