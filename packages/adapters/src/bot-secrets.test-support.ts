import type { PrismaClient } from "@rakazo/db";
import { vi } from "vitest";

// No database is available offline, so these run against an in-memory stand-in for the
// vault_credentials table. Encryption, validation, and redaction are the real implementations.
type Row = {
  id: string;
  userId: string;
  /** Null in the account vault. */
  spaceId: string | null;
  name: string;
  origin: string;
  auth: unknown;
  ciphertext: string;
};
type Where = Record<string, unknown>;

function matches(row: Row, where: Where) {
  return Object.entries(where).every(([key, value]) => {
    const field = row[key as keyof Row];
    if (value && typeof value === "object" && "not" in value) return field !== value.not;
    return field === value;
  });
}

/** A row in the member's account vault, which every Space without its own vault uses. */
export const accountVault = { userId: "user-1", spaceId: null };

export function fakeDatabase() {
  let rows: Row[] = [];
  // Spaces that customized "credentials" and so use their own vault.
  const ownVaults = new Set<string>();
  const vaultCredential = {
    findFirst: vi.fn(
      async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where, take }: { where: Where; take?: number }) =>
      rows
        .filter((row) => matches(row, where))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, take ?? rows.length),
    ),
    count: vi.fn(
      async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where)).length,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      rows.push({ ...data });
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      Object.assign(rows.find((row) => row.id === where.id)!, data);
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = rows.length;
      rows = rows.filter((row) => !matches(row, where));
      return { count: before - rows.length };
    }),
  };
  const client: Record<string, unknown> = {
    vaultCredential,
    spaceSettingOverride: {
      findUnique: vi.fn(
        async ({ where }: { where: { spaceId_userId_setting: { spaceId: string } } }) =>
          ownVaults.has(where.spaceId_userId_setting.spaceId) ? { setting: "credentials" } : null,
      ),
    },
    secret: { count: vi.fn(async () => 0), findFirst: vi.fn(async () => null) },
    // The previous release's table, still counted before a stored value is deleted.
    botSecret: { count: vi.fn(async () => 0) },
    integrationProviderConfig: { count: vi.fn(async () => 0) },
    // The member's settings lock always finds the membership row.
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
  };
  // One transaction at a time, as the bot row lock serializes them in Postgres, and a failed
  // one leaves the rows as they were.
  let queue: Promise<unknown> = Promise.resolve();
  client.$transaction = (fn: (tx: unknown) => Promise<unknown>) => {
    const next = queue.then(async () => {
      const before = rows.map((row) => ({ ...row }));
      try {
        return await fn(client);
      } catch (error) {
        rows = before;
        throw error;
      }
    });
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    rows: () => rows,
    useOwnVault: (spaceId: string) => ownVaults.add(spaceId),
    prisma: client as unknown as PrismaClient,
  };
}
