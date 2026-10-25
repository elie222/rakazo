import { usableModelId } from "@rakazo/contracts";
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
type Preference = {
  isDefault?: boolean;
  modelId?: string | null;
  thinkingLevel?: string | null;
  credential?: { provider: string };
};
type MockClient = {
  spaceModelPreference?: {
    findFirst?: (args: unknown) => Promise<unknown>;
    findMany?: (args: unknown) => Promise<unknown>;
  };
  spaceModelRoleChoice?: unknown;
  spaceBackupModel?: Record<string, unknown>;
  $transaction?: ((...args: unknown[]) => Promise<unknown>) & { mainRole?: true };
};

/**
 * Mocked clients written for the previous storage describe the main model as a default
 * preference. This gives them the role table the dual write keeps in step with it: rows read
 * from that preference until a test writes some, and stub writes for the previous release's copy.
 */
export function withMainRole<T>(prisma: T): T {
  const client = prisma as MockClient | null;
  if (!client || typeof client !== "object") return prisma;
  const written = new Map<string, RoleRow[]>();
  const key = (where: RoleWhere) => JSON.stringify([where.spaceId, where.userId, where.role]);
  const preferences = client.spaceModelPreference;
  const fromPreference = async (where: RoleWhere): Promise<RoleRow[]> => {
    if (where.role !== "main" || !where.spaceId || !where.userId || !preferences) return [];
    const scope = { spaceId: where.spaceId, userId: where.userId };
    const found = preferences.findFirst
      ? await preferences.findFirst({
          where: { ...scope, isDefault: true },
          include: { credential: true },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        })
      : (
          (await preferences.findMany?.({ where: scope, include: { credential: true } })) as
            | Preference[]
            | undefined
        )?.find((row) => row.isDefault);
    const preference = found as Preference | null | undefined;
    const modelId = usableModelId(preference?.modelId);
    return preference?.credential && preference.isDefault !== false && modelId
      ? [
          {
            ...scope,
            role: "main",
            position: 0,
            provider: preference.credential.provider,
            modelId,
            thinkingLevel: preference.thinkingLevel ?? null,
          },
        ]
      : [];
  };
  const roleTable = {
    findMany: vi.fn(async ({ where }: { where: RoleWhere }) =>
      written.has(key(where)) ? written.get(key(where))! : fromPreference(where),
    ),
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
    // A test's own role table answers its pin lookups; one role's list comes from memory.
    const own = target.spaceModelRoleChoice as
      | { findMany?: (args: { where: RoleWhere }) => Promise<unknown> }
      | undefined;
    target.spaceModelRoleChoice =
      own && own !== roleTable && !(own as { mainRole?: true }).mainRole
        ? {
            ...roleTable,
            ...own,
            mainRole: true,
            findMany: vi.fn((args: { where: RoleWhere }) =>
              args.where.role || !own.findMany ? roleTable.findMany(args) : own.findMany(args),
            ),
          }
        : (own ?? roleTable);
    target.spaceBackupModel = {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
      ...target.spaceBackupModel,
    };
    return target;
  };
  augment(client);
  const transaction = client.$transaction;
  if (typeof transaction === "function" && !transaction.mainRole) {
    client.$transaction = Object.assign(
      vi.fn((work: unknown, ...rest: unknown[]) =>
        transaction(
          typeof work === "function"
            ? (tx: MockClient) => (work as (tx: MockClient) => unknown)(augment(tx))
            : work,
          ...rest,
        ),
      ),
      { mainRole: true as const },
    );
  }
  return prisma;
}
