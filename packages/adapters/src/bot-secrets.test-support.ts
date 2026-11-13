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
  title?: string;
  note?: string;
  createdAt?: Date;
  updatedAt?: Date;
};
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Where[]).some((branch) => matches(row, branch));
    const field = row[key as keyof Row];
    if (field instanceof Date && value instanceof Date) return field.getTime() === value.getTime();
    if (value && typeof value === "object" && "not" in value) return field !== value.not;
    if (value && typeof value === "object" && "gt" in value)
      return String(field) > String(value.gt);
    if (value && typeof value === "object" && "startsWith" in value)
      return String(field).startsWith(String(value.startsWith));
    if (value && typeof value === "object" && "path" in value) {
      const filter = value as { path: string[]; equals: unknown };
      return (field as Record<string, unknown> | null)?.[filter.path[0]!] === filter.equals;
    }
    return field === value;
  });
}

/** A row in the member's account vault, which every Space without its own vault uses. */
export const accountVault = { userId: "user-1", spaceId: null };

export function fakeDatabase() {
  let rows: Row[] = [];
  // A clock that moves on every write, as updatedAt does, so a changed row is told apart.
  let tick = Date.parse("2026-09-01T00:00:00.000Z");
  const now = () => {
    tick += 1000;
    return new Date(tick);
  };
  // Spaces that customized "credentials" and so use their own vault.
  const ownVaults = new Set<string>();
  const vaultCredential = {
    findFirst: vi.fn(async ({ where }: { where: Where }) => {
      const row = rows.find((r) => matches(r, where));
      return row ? { ...row } : null;
    }),
    findMany: vi.fn(
      async ({
        where,
        take,
        orderBy,
      }: {
        where: Where;
        take?: number;
        orderBy?: { id?: "asc"; name?: "asc" };
      }) =>
        rows
          .filter((row) => matches(row, where))
          // By id as Postgres compares text ids for a cursor; by name otherwise.
          .sort((left, right) =>
            orderBy?.id
              ? Number(left.id > right.id) - Number(left.id < right.id)
              : left.name.localeCompare(right.name),
          )
          .slice(0, take ?? rows.length)
          .map((row) => ({ ...row })),
    ),
    count: vi.fn(
      async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where)).length,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const at = now();
      rows.push({ createdAt: at, updatedAt: at, ...data });
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      Object.assign(rows.find((row) => row.id === where.id)!, data, { updatedAt: now() });
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const matched = rows.filter((row) => matches(row, where));
      for (const row of matched) Object.assign(row, data, { updatedAt: data.updatedAt ?? now() });
      return { count: matched.length };
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
