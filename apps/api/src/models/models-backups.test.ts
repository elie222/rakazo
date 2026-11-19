import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import * as adapters from "@rakazo/adapters";
import { listPiCatalog, serializeModelSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  availableModel,
  owner,
  setupModelSettings as setup,
} from "./model-settings.test-support.js";

describe("model catalog offered to pickers", () => {
  it("leaves out models agents cannot run but keeps one the account saved", async () => {
    const { call, prisma } = setup();
    const saved = "openai/gpt-5.5-pro:batch";
    vi.mocked(prisma.bot.findMany).mockResolvedValue([
      { modelProvider: "openrouter", modelId: saved },
    ] as never);

    const { response } = await call("models/list", null);

    expect(response?.status).toBe(200);
    const { json } = (await response!.json()) as {
      json: Array<{ provider: string; id: string }>;
    };
    const openrouter = json.filter((entry) => entry.provider === "openrouter");
    expect(
      openrouter.filter((entry) => entry.id.endsWith(":batch")).map((entry) => entry.id),
    ).toEqual([saved]);
    expect(openrouter.some((entry) => entry.id === "anthropic/claude-haiku-5.5")).toBe(true);
  });
  it("marks Claude Code models managed only when the server's own sign-in runs them", async () => {
    const claudeCode = {
      ...listPiCatalog().find((entry) => entry.provider === "anthropic")!,
      provider: adapters.CLAUDE_CODE_PROVIDER_ID,
      id: "claude-sonnet-5",
    };
    const catalog = vi
      .spyOn(adapters, "listAvailablePiCatalog")
      .mockReturnValue([...listPiCatalog(), claudeCode]);
    try {
      const managed = async (defaultProvider: string) => {
        const { call, deps } = setup();
        deps.env.defaultProvider = defaultProvider;
        const { response } = await call("models/forRole", { role: "main" });
        const { json } = (await response.json()) as {
          json: Array<{ provider: string; managed?: boolean }>;
        };
        return json.find((entry) => entry.provider === claudeCode.provider)?.managed;
      };
      expect(await managed(adapters.CLAUDE_CODE_PROVIDER_ID)).toBe(true);
      expect(await managed("openrouter")).toBeUndefined();
    } finally {
      catalog.mockRestore();
    }
  });
});

describe("model backup settings API", () => {
  it("reads and saves a personal model when default-model billing is unavailable", async () => {
    const { call, deps, roles } = setup();
    const primary = { provider: availableModel.provider, modelId: availableModel.id };
    deps.env.deploymentModelConfigured = true;
    deps.billing = {
      status: vi.fn().mockRejectedValue(new Error("Fixture billing read failed")),
    } as unknown as NonNullable<typeof deps.billing>;

    const save = await call("models/setRole", { role: "main", primary });
    expect(save.response.status).toBe(200);
    expect((await save.response.json()).json).toMatchObject({ primary, deploymentPrimary: null });
    expect(roles()).toEqual([expect.objectContaining({ ...primary, position: 0 })]);
    const read = await call("models/role", { role: "main" });
    expect(read.response.status).toBe(200);
    expect((await read.response.json()).json).toMatchObject({ primary, deploymentPrimary: null });
  });

  it("rejects a compatible catalog placeholder outside the enabled list", async () => {
    const { call, userModelRoleChoice } = setup({
      compatible: { enabledModelIds: ["enabled"], defaultModel: "enabled" },
    });
    const { response } = await call("models/setBackups", [
      { provider: "openai-compatible", modelId: "custom" },
    ]);
    expect(response.status).toBe(400);
    expect(userModelRoleChoice.createMany).not.toHaveBeenCalled();
  });

  it("reads the member's account list, ignoring stale Space copies and other users", async () => {
    const { call, prisma } = setup({
      existing: [
        { userId: "user-one", provider: "openrouter", modelId: "first", position: 0 },
        {
          userId: "user-one",
          spaceId: "space-one",
          provider: "openrouter",
          modelId: "stale-space-copy",
          position: 0,
        },
        { userId: "user-two", provider: "openrouter", modelId: "other-user", position: 0 },
      ],
    });

    const { response } = await call("models/backups", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: [{ provider: "openrouter", modelId: "first" }],
    });
    expect(prisma.userModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: owner.userId, role: "main" } }),
    );
  });

  it("reads and writes a Space's own list while it overrides the account's", async () => {
    const { call, rows } = setup({
      overrides: [{ userId: owner.userId, spaceId: owner.spaceId }],
      existing: [
        { userId: owner.userId, provider: "openrouter", modelId: "account", position: 0 },
        {
          userId: owner.userId,
          spaceId: owner.spaceId,
          provider: "openrouter",
          modelId: "space-own",
          position: 0,
        },
      ],
    });

    const legacy = await call("models/backups", null);
    expect((await legacy.response.json()).json).toEqual([
      { provider: "openrouter", modelId: "space-own" },
    ]);
    const account = await call("models/role", { role: "main", scope: "account" });
    expect((await account.response.json()).json.backups).toEqual([
      expect.objectContaining({ modelId: "account" }),
    ]);

    const input = [{ provider: availableModel.provider, modelId: availableModel.id }];
    expect((await call("models/setBackups", input)).response.status).toBe(200);
    expect(rows()).toEqual([
      expect.objectContaining({ modelId: "account" }),
      expect.objectContaining({ spaceId: owner.spaceId, modelId: availableModel.id }),
    ]);

    // An explicit account write leaves the Space's copy alone.
    const accountWrite = await call("models/setRole", {
      role: "main",
      scope: "account",
      backups: [],
    });
    expect(accountWrite.response.status).toBe(200);
    expect(rows()).toEqual([
      expect.objectContaining({ spaceId: owner.spaceId, modelId: availableModel.id }),
    ]);
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
        provider: availableModel.provider,
        modelId: availableModel.id,
        position: 0,
      },
    ]);
    const preferences = (
      prisma as unknown as {
        userModelPreference: {
          upsert: ReturnType<typeof vi.fn>;
          updateMany: ReturnType<typeof vi.fn>;
        };
      }
    ).userModelPreference;
    expect(preferences.upsert).not.toHaveBeenCalled();
    expect(preferences.updateMany).not.toHaveBeenCalled();
  });

  it("rejects disconnected models, duplicate targets, and lists over the configured bound", async () => {
    const disconnected = setup();
    const invalid = await disconnected.call("models/setBackups", [
      { provider: "not-connected", modelId: "unknown-model" },
    ]);
    expect(invalid.response.status).toBeGreaterThanOrEqual(400);
    expect(disconnected.userModelRoleChoice.deleteMany).not.toHaveBeenCalled();

    const duplicate = setup();
    const repeated = { provider: availableModel.provider, modelId: availableModel.id };
    const duplicateResponse = await duplicate.call("models/setBackups", [repeated, repeated]);
    expect(duplicateResponse.response.status).toBeGreaterThanOrEqual(400);
    expect(duplicate.userModelRoleChoice.deleteMany).not.toHaveBeenCalled();

    const oversized = setup();
    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      provider: availableModel.provider,
      modelId: `${availableModel.id}-${index}`,
    }));
    const oversizedResponse = await oversized.call("models/setBackups", tooMany);
    expect(oversizedResponse.response.status).toBeGreaterThanOrEqual(400);
    expect(oversized.userModelRoleChoice.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a known catalog model when its provider is disconnected without replacing saved backups", async () => {
    const disconnectedModel = listPiCatalog().find(
      (entry) => entry.provider === "anthropic" && !entry.placeholder,
    )!;
    const existing = {
      userId: owner.userId,
      provider: availableModel.provider,
      modelId: availableModel.id,
      position: 0,
    };
    const { call, userModelRoleChoice, rows } = setup({ existing: [existing] });

    const { response } = await call("models/setBackups", [
      { provider: disconnectedModel.provider, modelId: disconnectedModel.id },
    ]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      json: { message: "Connect that model provider first" },
    });
    expect(userModelRoleChoice.deleteMany).not.toHaveBeenCalled();
    expect(userModelRoleChoice.createMany).not.toHaveBeenCalled();
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
    const { call, userModelRoleChoice } = setup({
      compatible: { enabledModelIds: ["local-a"], defaultModel: "local-a" },
    });

    const { response } = await call("models/setBackups", [
      { provider: "openai-compatible", modelId: "local-z" },
    ]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      json: { message: "Unknown model for that provider" },
    });
    expect(userModelRoleChoice.deleteMany).not.toHaveBeenCalled();
  });

  it("isolates writes between users", async () => {
    const actor: Actor = {
      ...owner,
      userId: "user-two",
      spaceId: "space-two",
      email: "two@rakazo.test",
    };
    const kept = { userId: owner.userId, provider: "openrouter", modelId: "keep", position: 0 };
    const { rows, call, userModelRoleChoice } = setup({ actor, existing: [kept] });

    await call("models/setBackups", []);

    expect(rows()).toEqual([kept]);
    expect(userModelRoleChoice.deleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, role: "main" },
    });
  });
});

describe("Space model overrides", () => {
  it("starts a Space's own models from the account's and drops them when it follows again", async () => {
    const { call, rows } = setup({
      existing: [{ userId: owner.userId, provider: "openrouter", modelId: "account", position: 0 }],
    });
    const overrides = async () =>
      (await (await call("spaceSettings/overrides", null)).response.json()).json;
    expect(await overrides()).toEqual([]);

    const customize = await call("spaceSettings/setOverride", { setting: "models", enabled: true });
    expect((await customize.response.json()).json).toEqual(["models"]);
    expect(rows()).toEqual([
      expect.objectContaining({ modelId: "account" }),
      expect.objectContaining({ spaceId: owner.spaceId, modelId: "account" }),
    ]);

    // Changes now land in the Space's copy only.
    expect((await call("models/setBackups", [])).response.status).toBe(200);
    expect(rows()).toEqual([expect.objectContaining({ modelId: "account" })]);

    const reset = await call("spaceSettings/setOverride", { setting: "models", enabled: false });
    expect((await reset.response.json()).json).toEqual([]);
    expect(await overrides()).toEqual([]);
    const legacy = await call("models/backups", null);
    expect((await legacy.response.json()).json).toEqual([
      { provider: "openrouter", modelId: "account" },
    ]);
  });
});

const visionModel = listPiCatalog().find(
  (entry) => entry.provider === "openrouter" && !entry.placeholder && entry.images,
)!;
const textOnlyModel = listPiCatalog().find(
  (entry) => entry.provider === "openrouter" && !entry.placeholder && entry.images === false,
)!;

describe("role-based model settings API", () => {
  describe("approval deployment default availability", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    function clearApprovalEnvironment() {
      for (const key of [
        "RAKAZO_AUTO_REVIEW_PROVIDER",
        "RAKAZO_AUTO_REVIEW_MODEL",
        "RAKAZO_LOCAL_MODELS",
        "PI_DEFAULT_PROVIDER",
        "PI_DEFAULT_MODEL",
        "PI_DEFAULT_CREDENTIALS",
        "OPENROUTER_API_KEY",
      ])
        vi.stubEnv(key, undefined);
    }

    it.each(["account", "space"])(
      "omits an unconnected approval default in %s reads and saves",
      async (scope) => {
        clearApprovalEnvironment();
        const { call, prisma } = setup();
        vi.mocked(prisma.userModelCredential.findMany).mockResolvedValue([]);
        for (const procedure of ["models/role", "models/setRole"]) {
          const { response } = await call(procedure, { role: "approval", scope });
          expect(response.status).toBe(200);
          expect((await response.json()).json).toMatchObject({
            primary: null,
            deploymentPrimary: null,
          });
        }
        expect(prisma.userModelCredential.findMany).toHaveBeenCalledWith({
          where: { userId: owner.userId, provider: "openrouter" },
        });
      },
    );

    it.each(["deployment", "connection", "local"])(
      "keeps an approval default runnable through %s configuration",
      async (configuration) => {
        clearApprovalEnvironment();
        const { call, prisma } = setup();
        const credentials = await prisma.userModelCredential.findMany({
          where: { userId: owner.userId },
        });
        vi.mocked(prisma.userModelCredential.findMany).mockResolvedValue([]);
        if (configuration === "deployment") vi.stubEnv("OPENROUTER_API_KEY", "fake-key");
        if (configuration === "connection") {
          vi.mocked(prisma.userModelCredential.findMany).mockResolvedValue(credentials);
        }
        if (configuration === "local") vi.stubEnv("RAKAZO_LOCAL_MODELS", "local-judge");
        const { response } = await call("models/role", { role: "approval" });
        expect(response.status).toBe(200);
        expect((await response.json()).json.deploymentPrimary).toMatchObject({
          provider: configuration === "local" ? "local" : "openrouter",
          ...(configuration === "local" ? { modelId: "local-judge" } : {}),
        });
      },
    );

    it("preserves a saved approval model when its connection is unavailable", async () => {
      clearApprovalEnvironment();
      const { call, prisma } = setup();
      const primary = { provider: availableModel.provider, modelId: availableModel.id };
      const saved = await call("models/setRole", { role: "approval", primary });
      expect(saved.response.status).toBe(200);
      vi.mocked(prisma.userModelCredential.findMany).mockResolvedValue([]);
      const { response } = await call("models/role", { role: "approval" });
      expect(response.status).toBe(200);
      expect((await response.json()).json).toMatchObject({ primary, deploymentPrimary: null });
    });

    it("keeps an approval default served by a connection stored under a provider alias", async () => {
      clearApprovalEnvironment();
      vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", "azure");
      vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", "gpt-4o");
      const { call } = setup({ credentialProvider: "azure-openai-responses" });
      const { response } = await call("models/role", { role: "approval" });
      expect(response.status).toBe(200);
      expect((await response.json()).json.deploymentPrimary).toEqual({
        provider: "azure",
        modelId: "gpt-4o",
      });
    });

    it.each(["retired", "missing", "unreadable"])(
      "omits an approval default with %s authentication",
      async (state) => {
        clearApprovalEnvironment();
        const { call, prisma, deps } = setup();
        if (state === "retired") {
          vi.mocked(deps.secrets.load).mockResolvedValue(
            serializeModelSecret({ kind: "oauth", reconnectRequired: true }),
          );
        } else if (state === "missing") {
          vi.mocked(prisma.secret.findFirst).mockResolvedValue(null);
        } else {
          vi.mocked(deps.secrets.load).mockRejectedValue(new Error("Unreadable fixture"));
        }
        const { response } = await call("models/role", { role: "approval" });
        expect(response.status).toBe(200);
        expect((await response.json()).json.deploymentPrimary).toBeNull();
      },
    );

    it.each([true, false])(
      "checks whether a compatible connection enables the approval model: %s",
      async (enabled) => {
        clearApprovalEnvironment();
        vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", "openai-compatible");
        vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", "judge");
        const { call } = setup({
          compatible: { enabledModelIds: enabled ? ["judge"] : ["other"], defaultModel: "other" },
        });
        const { response } = await call("models/role", { role: "approval" });
        expect(response.status).toBe(200);
        expect((await response.json()).json.deploymentPrimary).toEqual(
          enabled ? { provider: "openai-compatible", modelId: "judge" } : null,
        );
      },
    );

    it.each([true, false])(
      "checks the current private endpoint policy for an approval default: %s",
      async (allowPrivateEndpoint) => {
        clearApprovalEnvironment();
        vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", "openai-compatible");
        vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", "judge");
        const { call } = setup({
          allowPrivateEndpoint,
          compatible: { enabledModelIds: ["judge"], defaultModel: "judge" },
        });
        const { response } = await call("models/role", { role: "approval" });
        expect(response.status).toBe(200);
        expect((await response.json()).json.deploymentPrimary).toEqual(
          allowPrivateEndpoint ? { provider: "openai-compatible", modelId: "judge" } : null,
        );
      },
    );

    it.each([true, false])(
      "checks the current public endpoint policy for an approval default: %s",
      async (allowPublic) => {
        clearApprovalEnvironment();
        vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", "openai-compatible");
        vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", "judge");
        vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", allowPublic ? "1" : "0");
        const { call } = setup({
          compatible: {
            enabledModelIds: ["judge"],
            defaultModel: "judge",
            baseUrl: "https://models.example.test/v1",
          },
        });
        const { response } = await call("models/role", { role: "approval" });
        expect(response.status).toBe(200);
        expect((await response.json()).json.deploymentPrimary).toEqual(
          allowPublic ? { provider: "openai-compatible", modelId: "judge" } : null,
        );
      },
    );

    it.each([
      { name: "no authentication", apiKey: undefined, headers: undefined },
      { name: "an API key", apiKey: "fake-model-key", headers: undefined },
      { name: "custom headers", apiKey: undefined, headers: { "X-Auth": "fake-model-header" } },
    ])("checks public transport security with $name", async ({ apiKey, headers }) => {
      clearApprovalEnvironment();
      vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", "openai-compatible");
      vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", "judge");
      vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "1");
      for (const secure of [true, false]) {
        const { call, deps } = setup({
          compatible: { enabledModelIds: ["judge"], defaultModel: "judge" },
        });
        vi.mocked(deps.secrets.load).mockResolvedValue(
          serializeModelSecret({
            kind: "openai_compatible",
            baseUrl: `${secure ? "https" : "http"}://models.example.test/v1`,
            enabledModelIds: ["judge"],
            apiKey,
            headers,
          }),
        );
        const { response } = await call("models/role", { role: "approval" });
        expect(response.status).toBe(200);
        expect((await response.json()).json.deploymentPrimary).toEqual(
          secure || (!apiKey && !headers)
            ? { provider: "openai-compatible", modelId: "judge" }
            : null,
        );
      }
    });

    it.each([true, false])(
      "checks subscription access to an approval model against the live catalog: %s",
      async (listed) => {
        clearApprovalEnvironment();
        vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", "openai-codex");
        vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", "gpt-5.3-codex-spark");
        const { call, deps } = setup({
          credentialProvider: "openai-codex",
          codexCatalog: {
            read: vi.fn(async () =>
              listed
                ? [{ slug: "gpt-5.3-codex-spark", reasoningEfforts: [], supportsFastTier: false }]
                : [],
            ),
          },
        });
        vi.mocked(deps.secrets.load).mockResolvedValue(
          serializeModelSecret({
            kind: "oauth",
            credential: {
              type: "oauth",
              access: "fake-access",
              refresh: "fake-refresh",
              expires: Date.now() + 60_000,
              accountId: "fixture-account",
            },
          }),
        );
        const { response } = await call("models/role", { role: "approval" });
        expect(response.status).toBe(200);
        expect((await response.json()).json.deploymentPrimary).toEqual(
          listed ? { provider: "openai-codex", modelId: "gpt-5.3-codex-spark" } : null,
        );
      },
    );

    it("keeps reads and committed saves successful during a secret-store outage", async () => {
      clearApprovalEnvironment();
      const warn = vi.spyOn(getLogger(), "warn");
      const { call, deps, roles } = setup();
      const primary = { provider: availableModel.provider, modelId: availableModel.id };
      expect((await call("models/setRole", { role: "approval", primary })).response.status).toBe(
        200,
      );
      vi.mocked(deps.secrets.load).mockRejectedValue(new SecretStoreUnavailableError());
      for (const procedure of ["models/role", "models/setRole"]) {
        const { response } = await call(procedure, {
          role: "approval",
          ...(procedure === "models/setRole" ? { primary: null, backups: [] } : {}),
        });
        expect(response.status).toBe(200);
        expect((await response.json()).json.deploymentPrimary).toBeNull();
      }
      expect(roles().filter((row) => row.role === "approval")).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith("best effort failed: read approval model default", {
        error: expect.any(SecretStoreUnavailableError),
      });
    });
  });

  it("saves a computer-use model only when it can see images", async () => {
    const { call } = setup();
    const accepted = await call("models/setRole", {
      role: "computer",
      primary: { provider: "openrouter", modelId: visionModel.id },
    });
    expect(accepted.response.status).toBe(200);
    const refused = await call("models/setRole", {
      role: "computer",
      primary: { provider: "openrouter", modelId: textOnlyModel.id },
    });
    expect(refused.response.status).toBe(400);
  });
  it("says whether the main model reads images, as computer use decides it", async () => {
    const { call } = setup();
    const seesImages = async (modelId: string) => {
      const saved = await call("models/setRole", {
        role: "main",
        primary: { provider: "openrouter", modelId },
      });
      expect(saved.response.status).toBe(200);
      const read = await call("models/role", { role: "main" });
      return (await read.response.json()).json.seesImages;
    };
    expect(await seesImages(visionModel.id)).toBe(true);
    expect(await seesImages(textOnlyModel.id)).toBe(false);
    const approval = await call("models/role", { role: "approval" });
    expect((await approval.response.json()).json.seesImages).toBeUndefined();
  });
  it("offers only image-capable models for computer use", async () => {
    const { call } = setup();
    const { response } = await call("models/forRole", { role: "computer" });
    const entries: Array<{ id: string; images?: boolean }> = (await response.json()).json;
    expect(entries.some((entry) => entry.id === visionModel.id)).toBe(true);
    expect(entries.some((entry) => entry.images === false)).toBe(false);
  });
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
    expect(prisma.userModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: owner.userId, role: "approval" } }),
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
            userPreferences: [],
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
  it.each([false, true])(
    "offers and accepts only serving personal connections alongside credits (credits=%s)",
    async (credits) => {
      const { call, prisma, deps } = setup();
      if (credits) {
        deps.billing = { modelCreditsEnabled: true } as never;
        vi.stubEnv(
          "MODEL_CREDIT_OFFERINGS",
          JSON.stringify({
            defaultOfferingId: "approved",
            offerings: [
              {
                id: "approved",
                connectionId: "operator",
                provider: availableModel.provider,
                modelId: availableModel.id,
                price: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          }),
        );
        Object.assign(prisma.userModelCredential, {
          findUnique: vi.fn(async () => ({
            id: "operator",
            userId: "operator-owner",
            provider: availableModel.provider,
            secretId: "operator-secret",
          })),
        });
      }
      const connection = (id: string) => ({
        id,
        userId: owner.userId,
        provider: "openrouter",
        label: id,
        secretId: `${id}-secret`,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        userPreferences: [],
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
        for (const [procedure, input] of [
          ["models/forRole", { role: "main" }],
          ["models/list", null],
        ] as const) {
          const catalog = (await (await call(procedure, input)).response.json()).json as Array<{
            id: string;
            credentialIds?: string[];
          }>;
          expect(catalog.find((entry) => entry.id === availableModel.id)?.credentialIds).toEqual([
            "credential-personal",
          ]);
        }
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
        if (credits) {
          const funded = await call("models/setRole", {
            role: "main",
            primary: { ...model, creditOfferingId: "approved" },
          });
          expect(funded.response.status).toBe(200);
        }
      } finally {
        vi.unstubAllEnvs();
        serves.mockRestore();
      }
    },
  );
  it("reads each connection's key and the saved choices once for the whole catalog", async () => {
    const { call, prisma } = setup();
    const connection = (id: string) => ({
      id,
      userId: owner.userId,
      provider: "openrouter",
      label: id,
      secretId: `${id}-secret`,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      userPreferences: [],
    });
    Object.assign(prisma.userModelCredential, {
      findMany: vi.fn(async () => [
        connection("credential-personal"),
        connection("credential-work"),
      ]),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => connection(where.id)),
    });
    const secretRow = ({ where }: { where: { id: string } }) => ({
      id: where.id,
      ciphertext: `ciphertext-${where.id}`,
    });
    const findSecret = vi.fn(async (args: { where: { id: string } }) => secretRow(args));
    Object.assign(prisma.secret, {
      findFirst: findSecret,
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => secretRow({ where: { id } })),
      ),
    });
    // The work account's live list adds models the personal one does not list.
    const bundled = listPiCatalog()
      .filter((entry) => entry.provider === "openrouter" && !entry.placeholder)
      .map((entry) => entry.id);
    const liveOnly = bundled.slice(0, 20).map((id) => `${id}-preview`);
    const lists = vi
      .spyOn(adapters.ProviderCatalogCache.prototype, "read")
      .mockImplementation(async ({ secretId }) =>
        secretId === "credential-personal-secret" ? bundled : [...bundled, ...liveOnly],
      );
    vi.stubEnv("RAKAZO_LIVE_MODEL_CATALOG", "on");
    try {
      const catalog = (await (await call("models/forRole", { role: "main" })).response.json())
        .json as Array<{ id: string; credentialIds?: string[] }>;
      expect(catalog.filter((entry) => liveOnly.includes(entry.id))).toHaveLength(20);
      expect(catalog.find((entry) => entry.id === liveOnly[0])?.credentialIds).toEqual([
        "credential-work",
      ]);
      expect(findSecret).toHaveBeenCalledTimes(2);
      // Once for the catalog itself and once for the connections that may serve it.
      expect(prisma.bot.findMany).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
      lists.mockRestore();
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
    const preferences = prisma.userModelPreference as unknown as {
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
    // Connection A owns the model; model B is enabled only on connection B.
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
      userModelPreference: {
        findMany: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
      };
      secret: { findFirst: ReturnType<typeof vi.fn> };
    };
    client.userModelCredential.findMany.mockResolvedValue([connectionA, connectionB]);
    client.userModelPreference.findMany.mockResolvedValue([
      {
        modelId: "model-a",
        thinkingLevel: null,
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
    expect(client.userModelPreference.upsert).not.toHaveBeenCalled();
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
    const preferences = prisma.userModelPreference as unknown as {
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
