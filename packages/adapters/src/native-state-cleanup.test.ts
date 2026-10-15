import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { reconcileNativeStateCleanup } from "./native-state-cleanup.js";

const row = {
  id: "cleanup",
  spaceId: "space",
  userId: "user",
  scope: {
    computer: { id: "container", providerRef: "container", botId: "computer-home", kind: "docker" },
    botId: "target-bot",
    request: {
      expectedInstallationId: "a".repeat(32),
      sessionScope: {
        threadId: "thread",
        profileId: "profile",
        profileRevision: 1,
        accountId: "account",
        epoch: "old-epoch",
      },
    },
  },
};
function fixture() {
  const db = {
    nativeStateCleanup: {
      findMany: vi.fn().mockResolvedValue([row]),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const cleanupNativeState = vi.fn().mockResolvedValue(undefined);
  return {
    db,
    cleanupNativeState,
    deps: {
      prisma: db as unknown as PrismaClient,
      sandbox: { cleanupNativeState } as unknown as SandboxProvider,
    },
  };
}
describe("durable native state cleanup", () => {
  it("removes only the captured obsolete epoch and then acknowledges its tombstone", async () => {
    const f = fixture();
    await reconcileNativeStateCleanup(f.deps);
    expect(f.cleanupNativeState).toHaveBeenCalledWith(
      row.scope.computer,
      row.scope.request,
      expect.objectContaining({
        userId: "user",
        spaceId: "space",
        botId: "target-bot",
        runId: "native-cleanup-cleanup",
      }),
    );
    expect(f.db.nativeStateCleanup.deleteMany).toHaveBeenCalledWith({ where: { id: "cleanup" } });
  });
  it("retains active/offline namespaces for retry without storing raw diagnostics", async () => {
    const f = fixture();
    f.cleanupNativeState.mockRejectedValue(new Error("private bearer diagnostic"));
    await reconcileNativeStateCleanup(f.deps);
    expect(f.db.nativeStateCleanup.deleteMany).not.toHaveBeenCalled();
    expect(JSON.stringify(f.db.nativeStateCleanup.updateMany.mock.calls)).not.toContain("bearer");
    expect(f.db.nativeStateCleanup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ attempts: { increment: 1 } }) }),
    );
  });
  it("rejects malformed mixed scopes before touching the sandbox", async () => {
    const f = fixture();
    f.db.nativeStateCleanup.findMany.mockResolvedValue([
      { ...row, scope: { ...row.scope, request: { ...row.scope.request, credentialScope: {} } } },
    ]);
    await reconcileNativeStateCleanup(f.deps);
    expect(f.cleanupNativeState).not.toHaveBeenCalled();
    expect(f.db.nativeStateCleanup.deleteMany).not.toHaveBeenCalled();
  });
  it("leaves the durable queue intact when the provider lacks cleanup support", async () => {
    const f = fixture();
    f.deps.sandbox = {} as SandboxProvider;
    await reconcileNativeStateCleanup(f.deps);
    expect(f.db.nativeStateCleanup.findMany).not.toHaveBeenCalled();
  });
});
