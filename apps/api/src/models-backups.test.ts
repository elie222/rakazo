import { RPCHandler } from "@orpc/server/fetch";
import * as adapters from "@rakazo/adapters";
import { listPiCatalog, serializeModelSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const owner: Actor = {
  userId: "user-one",
  spaceId: "space-one",
  email: "one@rakazo.test",
  isDeploymentOwner: true,
};

function setup(
  options: {
    actor?: Actor;
    credits?: boolean;
    existing?: Array<Record<string, unknown>>;
    /** An openai-compatible connection with this stored list and space default. */
    compatible?: { enabledModelIds: string[]; defaultModel: string };
  } = {},
) {
  const credential = {
    id: "credential-one",
    userId: owner.userId,
    provider: options.compatible ? "openai-compatible" : "openrouter",
    label: "fixture",
    secretId: "secret-one",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  // `existing` describes the main model's fallbacks, positioned after its primary.
  let roleRows: Array<Record<string, unknown>> = (options.existing ?? []).map((row) => ({
    ...row,
    role: "main",
    position: Number(row.position) + 1,
    thinkingLevel: null,
  }));
  const spaceModelRoleChoice = {
    findMany: vi.fn(async ({ where }: { where: Record<string, string> }) =>
      roleRows
        .filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
        .sort((left, right) => Number(left.position) - Number(right.position)),
    ),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, string> }) => {
      roleRows = roleRows.filter(
        (row) => !Object.entries(where).every(([key, value]) => row[key] === value),
      );
      return { count: 0 };
    }),
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      roleRows.push(...data);
      return { count: data.length };
    }),
  };
  const tx = {
    spaceModelRoleChoice,
    $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
  };
  const prisma = {
    deploymentSettings: { findUnique: vi.fn(async () => null) },
    space: {
      findFirst: vi.fn(async () => ({ organization: { modelCredits: { mode: "credits" } } })),
    },
    spaceModelRoleChoice,
    userModelCredential: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; provider?: string } }) =>
        !options.credits &&
        where.userId === owner.userId &&
        (!where.provider || where.provider === credential.provider)
          ? [credential]
          : [],
      ),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; userId: string } }) =>
        !options.credits && where.userId === owner.userId && where.id === credential.id
          ? { ...credential, preferences: [] }
          : null,
      ),
    },
    spaceModelPreference: {
      findMany: vi.fn().mockResolvedValue(
        options.compatible
          ? [
              {
                id: "preference-one",
                modelId: options.compatible.defaultModel,
                thinkingLevel: null,
                isDefault: true,
                updatedAt: new Date(0),
                credential,
              },
            ]
          : [],
      ),
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
    spaceModelPreference: prisma.spaceModelPreference,
    userModelCredential: prisma.userModelCredential,
  });
  const deps = {
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
                baseUrl: "http://127.0.0.1:11434/v1",
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
    },
    dataDir: "C:/scratch/rakazo-model-backups",
  } as unknown as RouterDeps;
  const actor = options.actor ?? owner;
  const handler = new RPCHandler(createRouter(deps));
  const call = async (procedure: string, input: unknown) =>
    handler.handle(
      new Request(`http://127.0.0.1/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
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
  return { rows, roles, prisma, spaceModelRoleChoice, call };
}

const availableModel = listPiCatalog().find(
  (entry) => entry.provider === "openrouter" && !entry.placeholder,
)!;

describe("model backup settings API", () => {
  it("rejects a compatible catalog placeholder outside the enabled list", async () => {
    const { call, spaceModelRoleChoice } = setup({
      compatible: { enabledModelIds: ["enabled"], defaultModel: "enabled" },
    });
    const { response } = await call("models/setBackups", [
      { provider: "openai-compatible", modelId: "custom" },
    ]);
    expect(response.status).toBe(400);
    expect(spaceModelRoleChoice.createMany).not.toHaveBeenCalled();
  });

  it("returns an empty list for a new user and reads only that user's active Space", async () => {
    const { call, prisma } = setup({
      existing: [
        {
          userId: "user-one",
          spaceId: "space-one",
          provider: "openrouter",
          modelId: "first",
          position: 0,
        },
        {
          userId: "user-one",
          spaceId: "space-two",
          provider: "openrouter",
          modelId: "other-space",
          position: 0,
        },
        {
          userId: "user-two",
          spaceId: "space-one",
          provider: "openrouter",
          modelId: "other-user",
          position: 0,
        },
      ],
    });

    const { response } = await call("models/backups", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: [{ provider: "openrouter", modelId: "first" }],
    });
    expect(prisma.spaceModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: owner.userId, spaceId: owner.spaceId, role: "main" },
      }),
    );
  });

  it("persists an ordered list for a connected usable model without changing the primary", async () => {
    const { call, prisma, rows, roles } = setup();
    const input = [{ provider: availableModel.provider, modelId: availableModel.id }];

    const { response } = await call("models/setBackups", input);

    expect(response.status).toBe(200);
    // An installed app's backup list writes the main role.
    expect(roles()).toEqual([
      expect.objectContaining({ role: "main", position: 1, modelId: availableModel.id }),
    ]);
    expect(rows()).toEqual([
      {
        userId: owner.userId,
        spaceId: owner.spaceId,
        provider: availableModel.provider,
        modelId: availableModel.id,
        position: 0,
      },
    ]);
    const preferences = (
      prisma as unknown as {
        spaceModelPreference: {
          upsert: ReturnType<typeof vi.fn>;
          updateMany: ReturnType<typeof vi.fn>;
        };
      }
    ).spaceModelPreference;
    expect(preferences.upsert).not.toHaveBeenCalled();
    expect(preferences.updateMany).not.toHaveBeenCalled();
  });

  it("rejects disconnected models, duplicate targets, and lists over the configured bound", async () => {
    const disconnected = setup();
    const invalid = await disconnected.call("models/setBackups", [
      { provider: "not-connected", modelId: "unknown-model" },
    ]);
    expect(invalid.response.status).toBeGreaterThanOrEqual(400);
    expect(disconnected.spaceModelRoleChoice.deleteMany).not.toHaveBeenCalled();

    const duplicate = setup();
    const repeated = { provider: availableModel.provider, modelId: availableModel.id };
    const duplicateResponse = await duplicate.call("models/setBackups", [repeated, repeated]);
    expect(duplicateResponse.response.status).toBeGreaterThanOrEqual(400);
    expect(duplicate.spaceModelRoleChoice.deleteMany).not.toHaveBeenCalled();

    const oversized = setup();
    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      provider: availableModel.provider,
      modelId: `${availableModel.id}-${index}`,
    }));
    const oversizedResponse = await oversized.call("models/setBackups", tooMany);
    expect(oversizedResponse.response.status).toBeGreaterThanOrEqual(400);
    expect(oversized.spaceModelRoleChoice.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a known catalog model when its provider is disconnected without replacing saved backups", async () => {
    const disconnectedModel = listPiCatalog().find(
      (entry) => entry.provider === "anthropic" && !entry.placeholder,
    )!;
    const existing = {
      userId: owner.userId,
      spaceId: owner.spaceId,
      provider: availableModel.provider,
      modelId: availableModel.id,
      position: 0,
    };
    const { call, spaceModelRoleChoice, rows } = setup({ existing: [existing] });

    const { response } = await call("models/setBackups", [
      { provider: disconnectedModel.provider, modelId: disconnectedModel.id },
    ]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      json: { message: "Connect that model provider first" },
    });
    expect(spaceModelRoleChoice.deleteMany).not.toHaveBeenCalled();
    expect(spaceModelRoleChoice.createMany).not.toHaveBeenCalled();
    expect(rows()).toEqual([existing]);
  });

  it("accepts a backup on a second enabled openai-compatible model", async () => {
    const { call, rows } = setup({
      compatible: { enabledModelIds: ["local-a", "local-b"], defaultModel: "local-a" },
    });

    const { response } = await call("models/setBackups", [
      { provider: "openai-compatible", modelId: "local-b" },
    ]);

    expect(response.status).toBe(200);
    expect(rows()).toEqual([
      expect.objectContaining({ provider: "openai-compatible", modelId: "local-b", position: 0 }),
    ]);
  });

  it("rejects a backup on an openai-compatible model outside the enabled list", async () => {
    const { call, spaceModelRoleChoice } = setup({
      compatible: { enabledModelIds: ["local-a"], defaultModel: "local-a" },
    });

    const { response } = await call("models/setBackups", [
      { provider: "openai-compatible", modelId: "local-z" },
    ]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      json: { message: "Unknown model for that provider" },
    });
    expect(spaceModelRoleChoice.deleteMany).not.toHaveBeenCalled();
  });

  it("isolates writes between users and Spaces", async () => {
    const actor: Actor = {
      ...owner,
      userId: "user-two",
      spaceId: "space-two",
      email: "two@rakazo.test",
    };
    const { rows, call, spaceModelRoleChoice } = setup({
      actor,
      existing: [
        {
          userId: owner.userId,
          spaceId: owner.spaceId,
          provider: "openrouter",
          modelId: "keep",
          position: 0,
        },
      ],
    });

    await call("models/setBackups", []);

    expect(rows()).toEqual([
      {
        userId: owner.userId,
        spaceId: owner.spaceId,
        provider: "openrouter",
        modelId: "keep",
        position: 0,
      },
    ]);
    expect(spaceModelRoleChoice.deleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, spaceId: actor.spaceId, role: "main" },
    });
  });
});

describe("role-based model settings API", () => {
  it("accepts a decision model pinned to the provider's only connection", async () => {
    const { call } = setup();
    const primary = {
      provider: "openrouter",
      modelId: "typesafe/jev-1.14",
      credentialId: "credential-one",
    };
    const { response } = await call("models/setRole", { role: "approval", primary });
    expect(response.status).toBe(200);
    expect((await response.json()).json.primary).toMatchObject(primary);
  });
  it("stores approval choices independently of main backups using the existing connection", async () => {
    const { call, rows, prisma } = setup();
    const primary = { provider: "openrouter", modelId: "typesafe/jev-1.14" };
    const { response } = await call("models/setRole", {
      role: "approval",
      primary,
      backups: [{ provider: availableModel.provider, modelId: availableModel.id }],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.json.primary).toEqual(primary);
    expect(prisma.spaceModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: owner.userId, spaceId: owner.spaceId, role: "approval" },
      }),
    );
    const read = await call("models/role", { role: "approval" });
    expect((await read.response.json()).json).toEqual(body.json);
    expect(rows()).toEqual([]);
  });
  it("filters decision models out of main choices and rejects saving them for main", async () => {
    const { call } = setup();
    const main = await call("models/forRole", { role: "main" });
    expect(
      (await main.response.json()).json.some(
        (entry: { protocol?: string }) => entry.protocol === "decisions",
      ),
    ).toBe(false);
    const approval = await call("models/forRole", { role: "approval" });
    expect((await approval.response.json()).json).toContainEqual(
      expect.objectContaining({ id: "typesafe/jev-1.14", protocol: "decisions" }),
    );
    const invalid = await call("models/setRole", {
      role: "main",
      primary: { provider: "openrouter", modelId: "typesafe/jev-1.14" },
    });
    expect(invalid.response.status).toBe(400);
  });
  it("rejects stale sessions and unavailable connections without replacing settings", async () => {
    const { call } = setup();
    const stale = await call("models/setRole", {
      role: "approval",
      expectedUserId: "different-user",
      primary: null,
    });
    expect(stale.response.status).toBe(403);
    const missing = await call("models/setRole", {
      role: "approval",
      primary: { provider: "not-connected", modelId: "model" },
    });
    expect(missing.response.status).toBe(400);
    const read = await call("models/role", { role: "approval" });
    expect((await read.response.json()).json).toMatchObject({ primary: null, backups: [] });
  });
  it("lists the same model on two connections, each validated on its own", async () => {
    const { call, prisma, roles } = setup();
    const connections = ["credential-personal", "credential-work"];
    const findFirst = vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
      connections.includes(where.id) && where.userId === owner.userId
        ? {
            id: where.id,
            userId: owner.userId,
            provider: "openrouter",
            label: where.id,
            secretId: `${where.id}-secret`,
            createdAt: new Date(0),
            updatedAt: new Date(0),
            preferences: [],
          }
        : null,
    );
    Object.assign(prisma.userModelCredential, { findFirst });
    const model = { provider: availableModel.provider, modelId: availableModel.id };
    const primary = { ...model, credentialId: "credential-personal" };
    const backup = { ...model, credentialId: "credential-work" };

    const { response } = await call("models/setRole", {
      role: "main",
      primary,
      backups: [backup],
    });
    expect(response.status).toBe(200);
    expect((await response.json()).json).toMatchObject({ primary, backups: [backup] });
    expect(roles().map((row) => [row.position, row.credentialId])).toEqual([
      [0, "credential-personal"],
      [1, "credential-work"],
    ]);
    for (const id of connections)
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id }) }),
      );

    // A row may only run on a connection the member still has.
    const gone = await call("models/setRole", {
      role: "main",
      primary: { ...model, credentialId: "credential-removed" },
    });
    expect(gone.response.status).toBe(400);
  });
  it("offers and accepts a model only on the connections that can run it", async () => {
    const { call, prisma } = setup();
    const connection = (id: string) => ({
      id,
      userId: owner.userId,
      provider: "openrouter",
      label: id,
      secretId: `${id}-secret`,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      preferences: [],
    });
    Object.assign(prisma.userModelCredential, {
      findMany: vi.fn(async () => [
        connection("credential-personal"),
        connection("credential-work"),
      ]),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => connection(where.id)),
    });
    const serves = vi
      .spyOn(adapters, "connectionServesModel")
      .mockImplementation(
        async (_deps, _userId, credential, _provider, modelId) =>
          modelId !== availableModel.id || credential.secretId === "credential-personal-secret",
      );
    try {
      const catalog = (await (await call("models/forRole", { role: "main" })).response.json())
        .json as Array<{ id: string; credentialIds?: string[] }>;
      expect(catalog.find((entry) => entry.id === availableModel.id)?.credentialIds).toEqual([
        "credential-personal",
      ]);
      const model = { provider: availableModel.provider, modelId: availableModel.id };
      const wrong = await call("models/setRole", {
        role: "main",
        primary: { ...model, credentialId: "credential-work" },
      });
      expect(wrong.response.status).toBe(400);
      const right = await call("models/setRole", {
        role: "main",
        primary: { ...model, credentialId: "credential-personal" },
      });
      expect(right.response.status).toBe(200);
    } finally {
      serves.mockRestore();
    }
  });
  it("keeps the main model's effort when a list save repeats its primary", async () => {
    const { call, prisma, roles } = setup();
    const [thinking, other] = listPiCatalog().filter(
      (entry) =>
        entry.provider === "openrouter" &&
        !entry.placeholder &&
        entry.thinkingLevels?.includes("high"),
    );
    const primary = { provider: thinking!.provider, modelId: thinking!.id };
    const first = await call("models/setRole", {
      role: "main",
      primary: { ...primary, thinkingLevel: "high" },
    });
    expect(first.response.status).toBe(200);
    const preferences = prisma.spaceModelPreference as unknown as {
      upsert: ReturnType<typeof vi.fn>;
    };
    preferences.upsert.mockClear();

    const backups = [{ provider: other!.provider, modelId: other!.id }];
    const { response } = await call("models/setRole", { role: "main", primary, backups });
    expect(response.status).toBe(200);

    expect((await response.json()).json.primary).toEqual({ ...primary, thinkingLevel: "high" });
    expect(roles()[0]).toMatchObject({ position: 0, thinkingLevel: "high" });
    // The main model lives only in its role; the connection's own choice is untouched.
    expect(preferences.upsert).not.toHaveBeenCalled();
  });

  it("serves a compatible main model from the connection that enables it", async () => {
    // Connection A is the space default; model B is enabled only on connection B.
    const { call, prisma, roles } = setup({
      compatible: { enabledModelIds: ["model-a"], defaultModel: "model-a" },
    });
    const connection = (id: string) => ({
      id,
      userId: owner.userId,
      provider: "openai-compatible",
      label: id,
      secretId: `secret-${id}`,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const [connectionA, connectionB] = [connection("a"), connection("b")];
    const client = prisma as unknown as {
      userModelCredential: { findMany: ReturnType<typeof vi.fn> };
      spaceModelPreference: {
        findMany: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
      };
      secret: { findFirst: ReturnType<typeof vi.fn> };
    };
    client.userModelCredential.findMany.mockResolvedValue([connectionA, connectionB]);
    client.spaceModelPreference.findMany.mockResolvedValue([
      {
        id: "preference-a",
        modelId: "model-a",
        thinkingLevel: null,
        isDefault: true,
        updatedAt: new Date(0),
        credential: connectionA,
      },
    ]);
    client.secret.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      ciphertext: serializeModelSecret({
        kind: "openai_compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        enabledModelIds: [where.id === connectionB.secretId ? "model-b" : "model-a"],
      }),
    }));
    const { response } = await call("models/setRole", {
      role: "main",
      primary: { provider: "openai-compatible", modelId: "model-b" },
    });

    expect(response.status).toBe(200);
    expect(roles()).toEqual([
      expect.objectContaining({ position: 0, provider: "openai-compatible", modelId: "model-b" }),
    ]);
    expect(client.spaceModelPreference.upsert).not.toHaveBeenCalled();
  });

  it("retains backwards-compatible main backup storage", async () => {
    const { call } = setup();
    const backups = [{ provider: availableModel.provider, modelId: availableModel.id }];
    expect((await call("models/setRole", { role: "main", backups })).response.status).toBe(200);
    const legacy = await call("models/backups", {});
    expect((await legacy.response.json()).json).toEqual(backups);
  });
});

it("lets a deployment-managed model lead the main model like any other purpose", async () => {
  vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
  vi.stubEnv("OPENROUTER_API_KEY", "fake-hosted-key");
  try {
    const { call, prisma, roles } = setup({ credits: true });
    const primary = { provider: availableModel.provider, modelId: availableModel.id };
    const catalog = await call("models/forRole", { role: "main" });
    expect((await catalog.response.json()).json).toContainEqual(
      expect.objectContaining({ id: primary.modelId, managed: true }),
    );
    const main = await call("models/setRole", { role: "main", primary });
    expect(main.response.status).toBe(200);
    expect(roles()).toEqual([expect.objectContaining({ role: "main", position: 0 })]);
    const preferences = prisma.spaceModelPreference as unknown as {
      upsert: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    expect(preferences.upsert).not.toHaveBeenCalled();
    expect(preferences.updateMany).not.toHaveBeenCalled();
    const approval = await call("models/setRole", { role: "approval", primary });
    expect(approval.response.status).toBe(200);
  } finally {
    vi.unstubAllEnvs();
  }
});
