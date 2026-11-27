import type { ApiKey } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { requireIdentityConfirmation } from "../auth/identity-confirmation.js";
import type { RouterContext } from "../routes/context.js";

/** Plenty for every script someone runs; a cap keeps a stolen session from minting thousands. */
export const MAX_API_KEYS_PER_ACCOUNT = 50;

const LISTED = { id: true, name: true, start: true, createdAt: true, lastRequest: true } as const;

function apiKeyDto(row: {
  id: string;
  name: string | null;
  start: string | null;
  createdAt: Date;
  lastRequest: Date | null;
}): ApiKey {
  return {
    id: row.id,
    name: row.name ?? "",
    start: row.start,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastRequest?.toISOString() ?? null,
  };
}

/** The account's API keys. They belong to the person, not the Space they are signed in to. */
export function apiKeysRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    apiKeys: {
      list: authed.apiKeys.list.handler(async ({ context }) => {
        const rows = await deps.prisma.apiKey.findMany({
          where: { referenceId: context.actor.userId },
          orderBy: { createdAt: "desc" },
          select: LISTED,
        });
        return rows.map(apiKeyDto);
      }),
      create: authed.apiKeys.create.handler(async ({ context, input }) => {
        // A key outlives the session that made it, so the person proves it's them first.
        await requireIdentityConfirmation(deps.auth, context);
        const count = await deps.prisma.apiKey.count({
          where: { referenceId: context.actor.userId },
        });
        if (count >= MAX_API_KEYS_PER_ACCOUNT)
          throw new ClientError("CONFLICT", "Delete a key before adding another");
        const created = await deps.auth.createApiKey(context.actor.userId, input.name);
        return {
          ...apiKeyDto({ ...created, createdAt: new Date(created.createdAt), lastRequest: null }),
          key: created.key,
        };
      }),
      revoke: authed.apiKeys.revoke.handler(async ({ context, input }) => {
        const { count } = await deps.prisma.apiKey.deleteMany({
          where: { id: input.id, referenceId: context.actor.userId },
        });
        if (count === 0) throw new ClientError("NOT_FOUND", "Not Found");
        return { ok: true as const };
      }),
    },
  };
}
