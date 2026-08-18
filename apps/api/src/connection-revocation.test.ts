import { describe, expect, it, vi } from "vitest";
import { revokeConnection } from "./connection-revocation.js";

const context = {
  operationId: "connections.revoke",
  traceId: "connections.revoke",
  workspaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("connection revocation", () => {
  it("revokes the provider before committing local authorization", async () => {
    let status = "connected";
    const revoke = vi.fn(async () => {
      expect(status).toBe("connected");
    });
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: "connection-1",
          provider: "GOOGLETASKS",
        },
      ]),
      connection: {
        updateMany: vi.fn(async () => {
          status = "revoked";
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    };

    await revokeConnection(
      { prisma: prisma as never, composio: { revoke } },
      "connection-1",
      context,
    );

    expect(status).toBe("revoked");
    expect(revoke).toHaveBeenCalledOnce();
    expect(tx.connection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "connection-1",
        workspaceId: context.workspaceId,
        userId: context.userId,
      },
      data: { status: "revoked" },
    });
  });

  it("keeps local authorization retryable when provider revocation fails", async () => {
    let status = "connected";
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: "connection-1",
          provider: "GOOGLETASKS",
        },
      ]),
      connection: {
        updateMany: vi.fn(async () => {
          status = "revoked";
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    };

    await expect(
      revokeConnection(
        {
          prisma: prisma as never,
          composio: { revoke: vi.fn(async () => Promise.reject(new Error("offline"))) },
        },
        "connection-1",
        context,
      ),
    ).rejects.toThrow("offline");
    expect(status).toBe("connected");
    expect(tx.connection.updateMany).not.toHaveBeenCalled();
  });

  it("waits for an active mirror connection lease", async () => {
    let releaseMirror = () => {};
    const mirrorReleased = new Promise<void>((resolve) => {
      releaseMirror = resolve;
    });
    let lockRequested = () => {};
    const lockRequest = new Promise<void>((resolve) => {
      lockRequested = resolve;
    });
    const revoke = vi.fn(async () => {});
    const tx = {
      $queryRaw: vi.fn(async () => {
        lockRequested();
        await mirrorReleased;
        return [{ id: "connection-1", provider: "GOOGLETASKS" }];
      }),
      connection: {
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    };

    const revocation = revokeConnection(
      { prisma: prisma as never, composio: { revoke } },
      "connection-1",
      context,
    );
    await lockRequest;

    expect(revoke).not.toHaveBeenCalled();
    expect(tx.connection.updateMany).not.toHaveBeenCalled();

    releaseMirror();
    await revocation;

    expect(revoke).toHaveBeenCalledOnce();
    expect(tx.connection.updateMany).toHaveBeenCalledOnce();
  });
});
