import { describe, expect, it, vi } from "vitest";
import { deleteAgentSecret, listAgentSecrets, putAgentSecret } from "./agent-secrets.js";

const owner = {
  userId: "owner-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: true,
};

function makeDeps(role = "owner") {
  let existing: {
    id: string;
    spaceId: string;
    createdByUserId: string;
    name: string;
    secretId: string;
    createdAt: Date;
    updatedAt: Date;
  } | null = null;
  const rows: (typeof existing)[] = [];
  const prisma = {
    spaceMember: { findUnique: vi.fn(async () => ({ role })) },
    agentSecret: {
      findMany: vi.fn(async () => rows.filter(Boolean)),
      findUnique: vi.fn(async () => existing),
      findFirst: vi.fn(async () => existing),
      upsert: vi.fn(async ({ create, update }: { create: typeof existing; update: object }) => {
        const now = new Date("2026-09-02T12:00:00.000Z");
        existing = existing
          ? { ...existing, ...update, updatedAt: now }
          : { ...create!, id: "agent-secret-1", createdAt: now, updatedAt: now };
        rows.splice(0, rows.length, existing);
        return existing;
      }),
      delete: vi.fn(async () => existing),
    },
    secret: {
      create: vi.fn(async ({ data }: { data: { id: string } }) => data),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma),
    ),
  };
  const secrets = {
    put: vi.fn(async (_value: string, _context: unknown) => ({
      id: `encrypted-${secrets.put.mock.calls.length}`,
      ciphertext: "ciphertext-only",
    })),
  };
  return { prisma, secrets };
}

describe("agent secrets", () => {
  it("rejects non-owners before reading or writing shared secrets", async () => {
    const deps = makeDeps("member");

    await expect(listAgentSecrets(deps as never, owner)).rejects.toThrow();
    await expect(
      putAgentSecret(deps as never, owner, {
        name: "AUDIENTI_API_KEY",
        value: "private-test-value",
      }),
    ).rejects.toThrow();

    expect(deps.prisma.agentSecret.findMany).not.toHaveBeenCalled();
    expect(deps.secrets.put).not.toHaveBeenCalled();
  });

  it("stores ciphertext and returns metadata without the value", async () => {
    const deps = makeDeps();

    const result = await putAgentSecret(deps as never, owner, {
      name: "AUDIENTI_API_KEY",
      value: "private-test-value",
    });

    expect(deps.secrets.put).toHaveBeenCalledWith(
      "private-test-value",
      expect.objectContaining({ spaceId: "space-1", userId: "owner-1" }),
    );
    expect(deps.prisma.secret.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "encrypted-1",
        spaceId: "space-1",
        userId: "owner-1",
        kind: "agent-environment",
        ciphertext: "ciphertext-only",
      }),
    });
    expect(result).toEqual({
      id: "agent-secret-1",
      name: "AUDIENTI_API_KEY",
      createdAt: "2026-09-02T12:00:00.000Z",
      updatedAt: "2026-09-02T12:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("private-test-value");
    expect(JSON.stringify(result)).not.toContain("ciphertext-only");
  });

  it("rotates the encrypted record and deletes the previous ciphertext", async () => {
    const deps = makeDeps();
    await putAgentSecret(deps as never, owner, { name: "TOKEN", value: "first-value" });
    await putAgentSecret(deps as never, owner, { name: "TOKEN", value: "second-value" });

    expect(deps.prisma.secret.deleteMany).toHaveBeenCalledWith({
      where: { id: "encrypted-1", spaceId: "space-1" },
    });
  });

  it("scopes list and delete operations to the current Space", async () => {
    const deps = makeDeps();
    await putAgentSecret(deps as never, owner, { name: "TOKEN", value: "value" });

    await listAgentSecrets(deps as never, owner);
    await deleteAgentSecret(deps as never, owner, "agent-secret-1");

    expect(deps.prisma.agentSecret.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { spaceId: "space-1" } }),
    );
    expect(deps.prisma.agentSecret.findFirst).toHaveBeenCalledWith({
      where: { id: "agent-secret-1", spaceId: "space-1" },
      select: { id: true, secretId: true },
    });
  });
});
