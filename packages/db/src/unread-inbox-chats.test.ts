import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { currentDbContext, runAsTenant } from "./row-security.js";
import { countUnreadInboxChats } from "./unread-inbox-chats.js";

describe("unread inbox chat query", () => {
  it("uses one bound query with an explicit system scope and restores the tenant", async () => {
    const tenant = { userId: "user-1", spaceId: "space-1" };
    const query = vi.fn(async (sql: Prisma.Sql) => {
      const parameters = sql.values;
      expect(currentDbContext()).toEqual({
        kind: "system",
        reason: "count unread inbox chats across the member's Spaces",
      });
      expect(parameters).toContain(tenant.userId);
      expect(parameters).toContain(tenant.spaceId);
      return [{ count: 4 }];
    });
    const prisma = { $queryRaw: query } as unknown as PrismaClient;
    await runAsTenant(tenant, async () => {
      expect(await countUnreadInboxChats(prisma, tenant)).toBe(4);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...tenant });
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it("counts across every organization when no Space scopes it", async () => {
    const query = vi.fn(async (sql: Prisma.Sql) => {
      expect(sql.values).toContain("user-1");
      expect(sql.sql).not.toContain("organizationId");
      return [{ count: 7 }];
    });
    const prisma = { $queryRaw: query } as unknown as PrismaClient;
    expect(await countUnreadInboxChats(prisma, { userId: "user-1" })).toBe(7);
  });
});
