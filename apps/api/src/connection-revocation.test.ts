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
  it("revokes local authorization before calling the provider", async () => {
    let status = "connected";
    const revoke = vi.fn(async () => {
      expect(status).toBe("revoked");
    });
    const prisma = {
      connection: {
        findFirst: vi.fn(async () => ({
          id: "connection-1",
          workspaceId: context.workspaceId,
          userId: context.userId,
          provider: "GOOGLETASKS",
          status,
        })),
        updateMany: vi.fn(async () => {
          status = "revoked";
          return { count: 1 };
        }),
      },
    };

    await revokeConnection(
      { prisma: prisma as never, composio: { revoke } },
      "connection-1",
      context,
    );

    expect(status).toBe("revoked");
    expect(revoke).toHaveBeenCalledOnce();
    expect(prisma.connection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "connection-1",
        workspaceId: context.workspaceId,
        userId: context.userId,
      },
      data: { status: "revoked" },
    });
  });

  it("keeps local authorization revoked when provider revocation fails", async () => {
    let status = "connected";
    const prisma = {
      connection: {
        findFirst: vi.fn(async () => ({
          id: "connection-1",
          workspaceId: context.workspaceId,
          userId: context.userId,
          provider: "GOOGLETASKS",
          status,
        })),
        updateMany: vi.fn(async () => {
          status = "revoked";
          return { count: 1 };
        }),
      },
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
    expect(status).toBe("revoked");
  });
});
