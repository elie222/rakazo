import { vi } from "vitest";

type RoleRow = {
  spaceId: string;
  userId: string;
  role: string;
  position: number;
  provider: string;
  modelId: string;
  thinkingLevel: string | null;
};
type RoleWhere = { userId?: string; spaceId?: string; role?: string };
type MockClient = {
  spaceModelRoleChoice?: unknown;
  $transaction?: ((...args: unknown[]) => Promise<unknown>) & { modelRoles?: true };
};

/** One main-model row, as `withModelRoles` seeds it. */
export function mainRole(
  scope: { spaceId: string; userId: string },
  provider: string,
  modelId: string,
  thinkingLevel: string | null = null,
): RoleRow {
  return { ...scope, role: "main", position: 0, provider, modelId, thinkingLevel };
}

/**
 * Gives a mocked client an in-memory role table seeded with `rows`. A test's own
 * role table keeps answering its pin lookups; role lists come from memory.
 */
export function withModelRoles<T>(prisma: T, rows: RoleRow[] = []): T {
  const client = prisma as MockClient | null;
  if (!client || typeof client !== "object") return prisma;
  const written = new Map<string, RoleRow[]>();
  const key = (where: RoleWhere) => JSON.stringify([where.spaceId, where.userId, where.role]);
  for (const row of rows) written.set(key(row), [...(written.get(key(row)) ?? []), row]);
  const roleTable = {
    modelRoles: true as const,
    findMany: vi.fn(async ({ where }: { where: RoleWhere }) => written.get(key(where)) ?? []),
    deleteMany: vi.fn(async ({ where }: { where: RoleWhere }) => {
      written.set(key(where), []);
      return { count: 0 };
    }),
    createMany: vi.fn(async ({ data }: { data: RoleRow[] }) => {
      for (const row of data) written.set(key(row), [...(written.get(key(row)) ?? []), row]);
      return { count: data.length };
    }),
  };
  const augment = (target: MockClient) => {
    const own = target.spaceModelRoleChoice as
      | { findMany?: (args: { where: RoleWhere }) => Promise<unknown>; modelRoles?: true }
      | undefined;
    target.spaceModelRoleChoice =
      own && !own.modelRoles
        ? {
            ...roleTable,
            ...own,
            modelRoles: true,
            findMany: vi.fn((args: { where: RoleWhere }) =>
              args.where.role || !own.findMany ? roleTable.findMany(args) : own.findMany(args),
            ),
          }
        : (own ?? roleTable);
    return target;
  };
  augment(client);
  const transaction = client.$transaction;
  if (typeof transaction === "function" && !transaction.modelRoles) {
    client.$transaction = Object.assign(
      vi.fn((work: unknown, ...rest: unknown[]) =>
        transaction(
          typeof work === "function"
            ? (tx: MockClient) => (work as (tx: MockClient) => unknown)(augment(tx))
            : work,
          ...rest,
        ),
      ),
      { modelRoles: true as const },
    );
  }
  return prisma;
}
