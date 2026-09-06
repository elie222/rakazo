import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAgentSecret, listAgentSecrets, putAgentSecret } from "./agent-secrets.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

describe("agent secrets", () => {
  const put = vi.fn(async () => ({ id: "secret-1", ciphertext: "cipher" }));
  const prisma = {
    spaceMember: {
      findUnique: vi.fn(async () => ({ role: "owner" })),
    },
    agentSecret: {
      findMany: vi.fn(async () => [
        {
          id: "as-1",
          name: "ACME_TOKEN",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ]),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => ({ id: "as-1", secretId: "secret-1" })),
      upsert: vi.fn(async () => ({
        id: "as-1",
        name: "ACME_TOKEN",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      })),
      delete: vi.fn(async () => undefined),
    },
    secret: {
      create: vi.fn(async () => undefined),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.spaceMember.findUnique.mockResolvedValue({ role: "owner" });
  });

  it("lists secrets for space owners", async () => {
    await expect(
      listAgentSecrets({ prisma: prisma as never, secrets: { put } }, actor),
    ).resolves.toEqual([
      {
        id: "as-1",
        name: "ACME_TOKEN",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("rejects non-owners", async () => {
    prisma.spaceMember.findUnique.mockResolvedValue({ role: "member" });
    await expect(
      listAgentSecrets({ prisma: prisma as never, secrets: { put } }, actor),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it("puts and removes secrets", async () => {
    await putAgentSecret(
      { prisma: prisma as never, secrets: { put } },
      actor,
      { name: "ACME_TOKEN", value: "super-secret" },
    );
    expect(put).toHaveBeenCalled();
    expect(prisma.secret.create).toHaveBeenCalled();
    expect(prisma.agentSecret.upsert).toHaveBeenCalled();

    await expect(
      deleteAgentSecret({ prisma: prisma as never, secrets: { put } }, actor, "as-1"),
    ).resolves.toEqual({ ok: true });
    expect(prisma.agentSecret.delete).toHaveBeenCalledWith({ where: { id: "as-1" } });
  });
});
