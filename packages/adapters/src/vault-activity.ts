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
    const events = await prisma.auditEvent.findMany({
      where: { targetType: "vault_credential", targetId: id, action: "credential.used" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: VAULT_ACTIVITY_LIMIT,
      select: { createdAt: true, actorLabel: true, threadId: true, metadata: true },
    });
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
      const site = (event.metadata as Record<string, unknown> | null)?.site;
      return {
        at: event.createdAt.toISOString(),
        botName: event.actorLabel ?? "",
        site: typeof site === "string" ? site : null,
        chat: (event.threadId && chats.get(event.threadId)) || null,
      };
    });
  });
}
