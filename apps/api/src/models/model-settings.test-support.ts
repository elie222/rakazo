import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { listPiCatalog, serializeModelSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";
import { handleRpcError } from "../rpc-errors.js";

export const owner: Actor = {
  userId: "user-one",
  spaceId: "space-one",
  email: "one@rakazo.test",
  isDeploymentOwner: true,
};

export function setupModelSettings(
  options: {
    actor?: Actor;
    credentialProvider?: string;
    allowPrivateEndpoint?: boolean;
    codexCatalog?: RouterDeps["codexCatalog"];
    credits?: boolean;
    existing?: Array<Record<string, unknown>>;
    /** An openai-compatible connection with this stored list and own model. */
    compatible?: { enabledModelIds: string[]; defaultModel: string; baseUrl?: string };
    /** Spaces whose member keeps their own models instead of the account's. */
    overrides?: Array<{ userId: string; spaceId: string }>;
  } = {},
) {
  const userPreferences = options.compatible
    ? [{ modelId: options.compatible.defaultModel, thinkingLevel: null, updatedAt: new Date(0) }]
    : [];
  const credential = {
    id: "credential-one",
    userId: owner.userId,
    provider:
      options.credentialProvider ?? (options.compatible ? "openai-compatible" : "openrouter"),
    label: "fixture",
    secretId: "secret-one",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    userPreferences,
  };
  // `existing` describes the main model's fallbacks, positioned after its primary. A row
  // with a spaceId is that Space's own copy; one without is the account's.
  let roleRows: Array<Record<string, unknown>> = (options.existing ?? []).map((row) => ({
    ...row,
    role: "main",
    position: Number(row.position) + 1,
    thinkingLevel: null,
  }));
  const roleTable = (copy: "account" | "space") => {
    const owns = (row: Record<string, unknown>, where: Record<string, string>) =>
      (copy === "space") === (row.spaceId !== undefined) &&
      Object.entries(where).every(([key, value]) => row[key] === value);
    return {
      findMany: vi.fn(async ({ where }: { where: Record<string, string> }) =>
        roleRows
          .filter((row) => owns(row, where))
          .sort((left, right) => Number(left.position) - Number(right.position)),
      ),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        roleRows = roleRows.filter((row) => !owns(row, where));
        return { count: 0 };
      }),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        roleRows.push(...data);
        return { count: data.length };
      }),
    };
  };
  const userModelRoleChoice = roleTable("account");
  const spaceModelRoleChoice = roleTable("space");
  type OverrideKey = { spaceId: string; userId: string; setting: string };
  let overrides: OverrideKey[] = (options.overrides ?? []).map((row) => ({
    ...row,
    setting: "models",
  }));
  const sameOverride = (left: OverrideKey, right: OverrideKey) =>
    left.spaceId === right.spaceId &&
    left.userId === right.userId &&
    left.setting === right.setting;
  const spaceSettingOverride = {
    findUnique: vi.fn(
      async ({ where }: { where: { spaceId_userId_setting: OverrideKey } }) =>
        overrides.find((row) => sameOverride(row, where.spaceId_userId_setting)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where: { spaceId: string; userId: string } }) =>
      overrides.filter((row) => row.spaceId === where.spaceId && row.userId === where.userId),
    ),
    create: vi.fn(async ({ data }: { data: OverrideKey }) => {
      overrides.push(data);
      return data;
    }),
    delete: vi.fn(async ({ where }: { where: { spaceId_userId_setting: OverrideKey } }) => {
      overrides = overrides.filter((row) => !sameOverride(row, where.spaceId_userId_setting));
      return where.spaceId_userId_setting;
    }),
  };
  const tx = {
    userModelRoleChoice,
    spaceModelRoleChoice,
    spaceSettingOverride,
    $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
  };
  const prisma = {
    deploymentSettings: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    // Saved choices that keep a model listed after new users stop being offered it.
    bot: { findMany: vi.fn(async () => []) },
    routine: { findMany: vi.fn(async () => []) },
    space: {
      findFirst: vi.fn(async () => ({ organization: { modelCredits: { mode: "credits" } } })),
    },
    userModelRoleChoice,
    spaceModelRoleChoice,
    spaceSettingOverride,
    userModelCredential: {
      findMany: vi.fn(
        async ({ where }: { where: { userId: string; provider?: string | { in: string[] } } }) =>
          !options.credits &&
          where.userId === owner.userId &&
          (!where.provider ||
            (typeof where.provider === "string"
              ? where.provider === credential.provider
              : where.provider.in.includes(credential.provider)))
            ? [credential]
            : [],
      ),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; userId: string } }) =>
        !options.credits && where.userId === owner.userId && where.id === credential.id
          ? { ...credential, userPreferences: [] }
          : null,
      ),
    },
    userModelPreference: {
      findMany: vi.fn().mockResolvedValue(userPreferences.map((row) => ({ ...row, credential }))),
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    secret: {
      findMany: vi.fn().mockResolvedValue([{ id: "secret-one", ciphertext: "fixture-ciphertext" }]),
      findFirst: vi.fn().mockResolvedValue({ id: "secret-one", ciphertext: "fixture-ciphertext" }),
    },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient;
  Object.assign(tx, {
    userModelPreference: prisma.userModelPreference,
    userModelCredential: prisma.userModelCredential,
  });
  const deps = {
    codexCatalog: options.codexCatalog,
    billing: options.credits ? { modelCreditsEnabled: true } : undefined,
    prisma,
    secrets: {
      // A fixture ciphertext that is already a stored secret decrypts to itself.
      load: vi.fn((ciphertext: string) =>
        ciphertext.startsWith("{")
          ? ciphertext
          : options.compatible
            ? serializeModelSecret({
                kind: "openai_compatible",
                baseUrl: options.compatible.baseUrl ?? "http://127.0.0.1:11434/v1",
                enabledModelIds: options.compatible.enabledModelIds,
              })
            : "fake-api-key-for-offline-tests",
      ),
    },
    env: {
      agentRuntime: "pi",
      defaultProvider: "openrouter",
      defaultModel: "unused-test-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fixture-secret",
      sandboxProvider: "fake",
      mcpAllowPrivateEndpoint: options.allowPrivateEndpoint ?? true,
    },
    dataDir: "C:/scratch/rakazo-model-backups",
  } as unknown as RouterDeps;
  const actor = options.actor ?? owner;
  const handler = new RPCHandler(createRouter(deps), {
    clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
  });
  const call = async (procedure: string, input: unknown) => {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    if (!response) throw new Error(`no response for ${procedure}`);
    return { response };
  };
  const roles = () => roleRows;
  // The main model's fallbacks in the shape `existing` takes.
  const rows = () =>
    roleRows
      .filter((row) => row.role === "main" && Number(row.position) > 0)
      .map(({ userId, spaceId, provider, modelId, position }) => ({
        userId,
        spaceId,
        provider,
        modelId,
        position: Number(position) - 1,
      }));
  return { rows, roles, prisma, deps, userModelRoleChoice, spaceModelRoleChoice, call };
}

export const availableModel = listPiCatalog().find(
  (entry) => entry.provider === "openrouter" && !entry.placeholder,
)!;
