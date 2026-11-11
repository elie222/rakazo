import type { VaultUse } from "@rakazo/contracts";
import { VAULT_ACTIVITY_LIMIT } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import type { BotSecretScope } from "./bot-secrets.js";
import { vaultItemId } from "./bot-secrets.js";

// Uses sit in audit logs of organizations the owner may not read, so they are found by the item's
// id only after the caller is shown to own it.
export async function listVaultItemUses(
  prisma: PrismaClient,
  scope: BotSecretScope,
  name: string,
): Promise<VaultUse[] | undefined> {
  const id = await vaultItemId(prisma, scope, name);
  if (!id) return undefined;
  return runAsSystem("read a vault item's uses for its owner", async () => {
    const rows = await prisma.auditEvent.findMany({
      where: { targetType: "vault_credential", targetId: id, action: "credential.used" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: VAULT_ACTIVITY_LIMIT * 2,
      select: {
        createdAt: true,
        actorId: true,
        actorLabel: true,
        runId: true,
        threadId: true,
        metadata: true,
      },
    });
    const siteOf = (row: (typeof rows)[number]) =>
      (row.metadata as Record<string, unknown> | null)?.site;
    // A guest's use of an account item is written twice at one time, unnamed in the space's
    // organization and named in their own, so each unnamed row is dropped for one named row of the
    // same moment, bot, run and chat; a Space vault item's is one unnamed row, listed as it is. A
    // row with a site is always its own use: a login used on two sites is two.
    const key = (row: (typeof rows)[number]) =>
      JSON.stringify([row.createdAt.getTime(), row.actorId, row.runId, row.threadId]);
    const named = new Map<string, number>();
    for (const row of rows) if (siteOf(row)) named.set(key(row), (named.get(key(row)) ?? 0) + 1);
    const events = rows
      .filter((row) => {
        if (siteOf(row)) return true;
        const twins = named.get(key(row)) ?? 0;
        named.set(key(row), Math.max(0, twins - 1));
        return twins === 0;
      })
      .slice(0, VAULT_ACTIVITY_LIMIT);
    const threadIds = [...new Set(events.flatMap((event) => event.threadId ?? []))];
    // Only the owner's own chats are named.
    const threads = threadIds.length
      ? await prisma.thread.findMany({
          where: { id: { in: threadIds }, userId: scope.userId },
          select: { id: true, bot: { select: { name: true } }, group: { select: { name: true } } },
        })
      : [];
    const chats = new Map(
      threads.flatMap((thread) => {
        const title = thread.group?.name ?? thread.bot?.name;
        return title === undefined ? [] : [[thread.id, { title }] as const];
      }),
    );
    return events.map((event) => {
      const site = siteOf(event);
      return {
        at: event.createdAt.toISOString(),
        botName: event.actorLabel ?? "",
        site: typeof site === "string" ? site : null,
        chat: (event.threadId && chats.get(event.threadId)) || null,
      };
    });
  });
}
