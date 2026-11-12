import type { PrismaClient } from "@rakazo/db";

type Row = {
  id: string;
  spaceId: string;
  userId: string;
  tag: string;
  ciphertext: string;
  botIds: string[];
};
type Where = { spaceId_userId: { spaceId: string; userId: string } };

/** tailnet_connections keyed by (spaceId, userId), plus the Space's bots. */
export function tailnetDatabase(bots: Array<{ id: string; spaceId: string }> = []) {
  const rows = new Map<string, Row>();
  const key = (where: Where) => `${where.spaceId_userId.spaceId}/${where.spaceId_userId.userId}`;
  const pick = <T extends object>(row: T | undefined, select: Record<string, boolean>) =>
    row
      ? (Object.fromEntries(Object.keys(select).map((name) => [name, row[name as keyof T]])) as T)
      : null;
  const tailnetConnection = {
    findUnique: async ({ where, select }: { where: Where; select: Record<string, boolean> }) =>
      pick(rows.get(key(where)), select),
    upsert: async (args: {
      where: Where;
      create: Omit<Row, "botIds">;
      update: Partial<Row>;
      select: Record<string, boolean>;
    }) => {
      const current = rows.get(key(args.where));
      const next = current ? { ...current, ...args.update } : { ...args.create, botIds: [] };
      rows.set(key(args.where), next);
      return pick(next, args.select);
    },
    update: async (args: { where: Where; data: Partial<Row>; select: Record<string, boolean> }) => {
      const next = { ...(rows.get(key(args.where)) as Row), ...args.data };
      rows.set(key(args.where), next);
      return pick(next, args.select);
    },
    deleteMany: async ({ where }: { where: { spaceId: string; userId: string } }) => ({
      count: rows.delete(`${where.spaceId}/${where.userId}`) ? 1 : 0,
    }),
    count: async ({ where }: { where: { ciphertext: string } }) =>
      [...rows.values()].filter((row) => row.ciphertext === where.ciphertext).length,
  };
  const none = { count: async () => 0 };
  const bot = {
    findFirst: async ({ where }: { where: { id: string; spaceId: string } }) =>
      bots.find((entry) => entry.id === where.id && entry.spaceId === where.spaceId) ?? null,
  };
  return {
    rows,
    prisma: {
      tailnetConnection,
      bot,
      secret: none,
      botSecret: none,
      vaultCredential: none,
      integrationProviderConfig: none,
    } as unknown as PrismaClient,
  };
}
