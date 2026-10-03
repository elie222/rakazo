import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { agentMessagesMarkUnread } from "./agent-message-preferences.js";

function fakePrisma(value: boolean | null) {
  return {
    notificationPreference: {
      findUnique: vi
        .fn()
        .mockResolvedValue(value === null ? null : { markAgentMessagesUnread: value }),
    },
  };
}

describe("agent-message unread preference", () => {
  it("defaults missing preferences to off and scopes the lookup to the active user and Space", async () => {
    const prisma = fakePrisma(null);

    await expect(
      agentMessagesMarkUnread(prisma, { spaceId: "space-a", userId: "user-a" }),
    ).resolves.toBe(false);
    expect(prisma.notificationPreference.findUnique).toHaveBeenCalledWith({
      where: { spaceId_userId: { spaceId: "space-a", userId: "user-a" } },
      select: { markAgentMessagesUnread: true },
    });
  });

  it("keeps users and Spaces independent", async () => {
    const findUnique = vi.fn(
      ({ where }: { where: { spaceId_userId: { spaceId: string; userId: string } } }) =>
        Promise.resolve({
          markAgentMessagesUnread:
            where.spaceId_userId.spaceId === "shared" && where.spaceId_userId.userId === "user-on",
        }),
    );
    const prisma = { notificationPreference: { findUnique } };

    await expect(
      agentMessagesMarkUnread(prisma, { spaceId: "shared", userId: "user-on" }),
    ).resolves.toBe(true);
    await expect(
      agentMessagesMarkUnread(prisma, { spaceId: "shared", userId: "user-off" }),
    ).resolves.toBe(false);
    await expect(
      agentMessagesMarkUnread(prisma, { spaceId: "other", userId: "user-on" }),
    ).resolves.toBe(false);
  });

  it("backfills existing rows and defaults new rows off in the migration", () => {
    const migrationPath = fileURLToPath(
      new URL(
        "../prisma/migrations/20261002090000_agent_unread_preference/migration.sql",
        import.meta.url,
      ),
    );
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain('ADD COLUMN "markAgentMessagesUnread" BOOLEAN NOT NULL DEFAULT false');
  });
});
