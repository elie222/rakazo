import { describe, expect, it, vi } from "vitest";
import { readConnectionQuota } from "./model-quota.js";
import type { RouterContext } from "./routes/context.js";

vi.mock("@rakazo/adapters", () => ({
  parseModelSecret: JSON.parse,
  oauthCredentialAccountId: (credential: { accountId?: string }) => credential.accountId,
}));

const actor = { userId: "user-a", spaceId: "space-a" };
function fixture() {
  const row = {
    id: "connection-a",
    userId: actor.userId,
    provider: "openai-codex",
    secretId: "secret-a",
  };
  const load = vi.fn(async () =>
    JSON.stringify({
      kind: "oauth",
      credential: {
        access: "test-token",
        accountId: "test-account",
        expires: Date.now() + 120_000,
      },
    }),
  );
  const deps = {
    prisma: {
      userModelCredential: { findFirst: vi.fn(async () => row) },
      secret: {
        findFirst: vi.fn(async () => ({ id: "secret-a", ciphertext: "encrypted-revision" })),
      },
    },
    secrets: { load },
  };
  const refreshExpiredCredential = vi.fn(async () => undefined);
  const ctx = { deps, refreshExpiredCredential } as unknown as RouterContext;
  const read = vi.fn(async () => ({ view: { status: "fresh" } }));
  const reader = { read } as unknown as Parameters<typeof readConnectionQuota>[1];
  return { ctx, reader, read, deps, refreshExpiredCredential, load };
}

describe("connection quota authorization", () => {
  it("loads only the exact owned connection and user-owned global secret", async () => {
    const f = fixture();
    await readConnectionQuota(f.ctx, f.reader, actor, "connection-a");
    expect(f.deps.prisma.userModelCredential.findFirst).toHaveBeenCalledWith({
      where: { id: "connection-a", userId: actor.userId },
    });
    expect(f.deps.prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "secret-a", userId: actor.userId, spaceId: null },
    });
    expect(f.read).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: "connection-a",
        accessToken: "test-token",
        accountId: "test-account",
      }),
      { fresh: false },
    );
  });
  it("rejects a foreign or missing connection before reading secrets or quota", async () => {
    const f = fixture();
    f.deps.prisma.userModelCredential.findFirst.mockResolvedValue(null as never);
    await expect(readConnectionQuota(f.ctx, f.reader, actor, "foreign")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(f.load).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it("requests native locked refresh for an expired token and does not use it", async () => {
    const f = fixture();
    f.load.mockResolvedValue(
      JSON.stringify({
        kind: "oauth",
        credential: { access: "expired-token", expires: Date.now() - 1000 },
      }),
    );
    await readConnectionQuota(f.ctx, f.reader, actor, "connection-a");
    expect(f.refreshExpiredCredential).toHaveBeenCalledWith(actor, "secret-a", "openai-codex");
    expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ accessToken: null }), {
      fresh: false,
    });
  });
  it("never passes corrupt secret diagnostics to the reader", async () => {
    const f = fixture();
    f.load.mockRejectedValue(new Error("private secret diagnostic"));
    await readConnectionQuota(f.ctx, f.reader, actor, "connection-a");
    expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ accessToken: null }), {
      fresh: false,
    });
  });
});
