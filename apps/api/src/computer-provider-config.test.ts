import type { BackgroundJob, SandboxProvider } from "@rakazo/adapter-kit";
import {
  computerProviderDescriptors,
  recordSecretCleanup,
  retrySecretCleanup,
  secretCleanupJobKey,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  effectiveSandboxProvider,
  getAccountComputerSettings,
  getComputerProviderSettings,
  updateAccountComputerSettings,
  updateComputerProviderSettings,
} from "./computer-provider-config.js";

const actor = { userId: "user-1", spaceId: "space-1", email: "admin@example.com" } as never;

const testDesktop = {
  desktopId: "ecd-test",
  endUserId: "test-user",
  mcpUrl: "https://gateway.example.com/mcp",
  accessKeyId: "test-id",
  accessKeySecret: "test-secret",
  mcpToken: "test-token",
};

/**
 * An in-memory deployment settings row and secret table behind the calls the config makes.
 * `remote` makes the store hold its values elsewhere, as a hosted secret store does.
 */
function makeDeps(
  options: { admin?: boolean; computerSettingsEnabled?: boolean; remote?: boolean } = {},
) {
  const state = {
    settings: null as null | {
      computerProvider: string | null;
      computerProviderCipher: string | null;
    },
    secrets: new Map<string, string>(),
  };
  let nextSecret = 0;
  const queued = new Map<string, BackgroundJob>();
  const queue = async (job: BackgroundJob) => {
    queued.set(job.replaceKey ?? "", job);
  };
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ email: "admin@example.com", emailVerified: true })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => state.settings),
      upsert: vi.fn(async ({ update }: { update: Record<string, string | null> }) => {
        state.settings = {
          computerProvider: null,
          computerProviderCipher: null,
          ...state.settings,
          ...update,
        };
        return state.settings;
      }),
    },
    secret: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.secrets.has(where.id) ? { id: where.id, ciphertext: where.id } : null,
      ),
      create: vi.fn(async ({ data }: { data: { id: string } }) => ({ id: data.id })),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        state.secrets.delete(where.id);
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: {
      put: vi.fn(async (plaintext: string) => {
        const id = `secret-${++nextSecret}`;
        state.secrets.set(id, plaintext);
        return { id, ref: id, ciphertext: id };
      }),
      load: vi.fn(async (ciphertext: string) => state.secrets.get(ciphertext) ?? ""),
      delete: vi.fn(async (ciphertext: string, _context: unknown) => {
        state.secrets.delete(ciphertext);
      }),
      isRemote: () => options.remote ?? false,
    },
    jobs: {
      enqueue: vi.fn(queue),
      enqueueIn: vi.fn((_tx: unknown, job: BackgroundJob) => queue(job)),
      cancel: vi.fn(async (key: string) => {
        queued.delete(key);
      }),
      cancelIn: vi.fn(async (_tx: unknown, key: string) => {
        queued.delete(key);
      }),
    },
    sandbox: { describe: () => ({ id: "docker" }) } as unknown as SandboxProvider,
    env: {
      sandboxProvider: "docker",
      adminEmails: options.admin === false ? [] : ["admin@example.com"],
      computerSettingsEnabled: options.computerSettingsEnabled ?? true,
    },
    resolveHostname: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    verifyConnection: vi.fn(async () => undefined),
  };
  return { deps, state, prisma, queued };
}

describe("computer provider settings", () => {
  it("is for admins only", async () => {
    const { deps } = makeDeps({ admin: false });
    await expect(getComputerProviderSettings(deps, actor)).rejects.toThrow("Admins only");
    await expect(
      updateComputerProviderSettings(deps, actor, {
        provider: "desktop",
        values: testDesktop,
      }),
    ).rejects.toThrow("Admins only");
  });

  it("offers no providers and refuses one unless the deployment enables computer settings", async () => {
    const { deps, state } = makeDeps({ computerSettingsEnabled: false });
    await expect(getComputerProviderSettings(deps, actor)).resolves.toMatchObject({
      provider: "default",
      providers: [],
    });
    await expect(
      updateComputerProviderSettings(deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("This deployment cannot use computer settings");
    expect(state.secrets.size).toBe(0);
  });

  it("checks the desktop, stores the connection encrypted and never returns secrets", async () => {
    const { deps, state } = makeDeps();
    const saved = await updateComputerProviderSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    expect(deps.verifyConnection).toHaveBeenCalledOnce();
    expect(state.settings).toMatchObject({ computerProvider: "desktop" });
    expect(saved).toMatchObject({
      provider: "desktop",
      defaultProvider: "docker",
      values: { desktopId: "ecd-test", mcpUrl: testDesktop.mcpUrl },
      savedSecrets: { accessKeyId: true, accessKeySecret: true, mcpToken: true },
    });
    expect(saved.values).not.toHaveProperty("accessKeyId");
    expect(JSON.stringify(saved)).not.toContain("test-secret");
    expect(await getComputerProviderSettings(deps, actor)).toEqual(saved);
  });

  it("keeps saved secrets when their fields are left blank", async () => {
    const { deps, state } = makeDeps();
    await updateComputerProviderSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    await updateComputerProviderSettings(deps, actor, {
      provider: "desktop",
      values: { ...testDesktop, desktopId: "ecd-other", accessKeySecret: "", mcpToken: "" },
    });
    const current = state.secrets.get(state.settings?.computerProviderCipher ?? "") ?? "";
    expect(JSON.parse(current).values).toMatchObject({
      desktopId: "ecd-other",
      accessKeySecret: "test-secret",
      mcpToken: "test-token",
    });
    // The replaced ciphertext is removed.
    expect(state.secrets.size).toBe(1);
  });

  it("removes the new ciphertext when saving it fails", async () => {
    const { deps, prisma, state } = makeDeps();
    prisma.deploymentSettings.upsert.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      updateComputerProviderSettings(deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("database unavailable");
    expect(deps.secrets.delete).toHaveBeenCalledWith("secret-1", "deployment-computer-provider");
    expect(state.secrets.size).toBe(0);
  });

  it("sends the saved token only to the gateway it was saved for", async () => {
    const { deps } = makeDeps();
    await updateComputerProviderSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    await expect(
      updateComputerProviderSettings(deps, actor, {
        provider: "desktop",
        values: { ...testDesktop, mcpUrl: "https://other.example.com/mcp", mcpToken: "" },
      }),
    ).rejects.toThrow("Could not verify computer settings");
    expect(deps.verifyConnection).toHaveBeenCalledTimes(1);
  });

  it("refuses incomplete or unreachable settings without saving", async () => {
    const { deps, state } = makeDeps();
    await expect(
      updateComputerProviderSettings(deps, actor, {
        provider: "desktop",
        values: { ...testDesktop, mcpToken: "" },
      }),
    ).rejects.toThrow("Could not verify computer settings");
    deps.verifyConnection.mockRejectedValueOnce(new Error("ConnectionRefused"));
    await expect(
      updateComputerProviderSettings(deps, actor, {
        provider: "desktop",
        values: testDesktop,
      }),
    ).rejects.toThrow("Could not verify computer settings");
    expect(state.settings).toBeNull();
  });

  it("removes the saved keys when switching back to the default", async () => {
    const { deps, state } = makeDeps();
    await updateComputerProviderSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    const back = await updateComputerProviderSettings(deps, actor, {
      provider: "default",
      values: {},
    });
    expect(back.provider).toBe("default");
    expect(back.values).toEqual({});
    expect(state.settings?.computerProvider).toBeNull();
    expect(state.settings?.computerProviderCipher).toBeNull();
    expect(state.secrets.size).toBe(0);
  });

  it("queues nothing for a store that keeps its values in the database", async () => {
    const { deps, queued } = makeDeps();
    await updateComputerProviderSettings(deps, actor, { provider: "desktop", values: testDesktop });
    await updateComputerProviderSettings(deps, actor, { provider: "default", values: {} });
    expect(deps.jobs.enqueueIn).not.toHaveBeenCalled();
    expect(queued.size).toBe(0);
  });

  describe("with a remote secret store", () => {
    const replaced = {
      kind: "deployment_computer_provider",
      recordId: "deployment-computer-provider",
      ref: "secret-1",
    } as const;
    const save = (deps: ReturnType<typeof makeDeps>["deps"], desktopId = "ecd-test") =>
      updateComputerProviderSettings(deps, actor, {
        provider: "desktop",
        values: { ...testDesktop, desktopId },
      });

    it("records the removal with the save and drops the record once it succeeds", async () => {
      const { deps, state, queued } = makeDeps({ remote: true });
      await save(deps);
      await save(deps, "ecd-other");
      expect(deps.jobs.enqueueIn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          name: "secret.cleanup",
          payload: replaced,
          availableAt: expect.any(Date),
        }),
      );
      expect(deps.secrets.delete).toHaveBeenCalledWith(
        "secret-1",
        expect.objectContaining({ recordId: "deployment-computer-provider" }),
      );
      expect([...state.secrets.keys()]).toEqual(["secret-2"]);
      expect(queued.size).toBe(0);
    });

    it("keeps a backup a concurrent replace records right after the save commits", async () => {
      const { deps, prisma, queued } = makeDeps({ remote: true });
      prisma.$transaction.mockImplementationOnce(async (callback) => {
        const result = await callback(prisma);
        // Committed: another request replaces this connection and records the backup that
        // deletes it, under the same job key as this save's write-ahead job.
        await recordSecretCleanup(deps, prisma as never, replaced);
        return result;
      });
      await save(deps);
      expect(deps.jobs.cancelIn).toHaveBeenCalledWith(prisma, secretCleanupJobKey("secret-1"));
      expect(queued.get(secretCleanupJobKey("secret-1"))).toMatchObject({ payload: replaced });
    });

    it("saves as usual when the replaced connection cannot be removed, and retries it later", async () => {
      const { deps, state, queued } = makeDeps({ remote: true });
      await save(deps);
      deps.secrets.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
      const saved = await save(deps, "ecd-other");
      expect(saved).toMatchObject({ provider: "desktop", values: { desktopId: "ecd-other" } });
      expect(state.settings?.computerProviderCipher).toBe("secret-2");
      expect(state.secrets.has("secret-1")).toBe(true);
      const [job] = [...queued.values()];
      expect(job).toMatchObject({ name: "secret.cleanup", payload: replaced });
      // Handed over to run now, and only ever by reference.
      expect(job).not.toHaveProperty("availableAt");
      expect(JSON.stringify(job)).not.toContain("test-secret");

      await retrySecretCleanup(deps, replaced);
      expect([...state.secrets.keys()]).toEqual(["secret-2"]);
    });

    it("retries removing saved keys that going back to the default left behind", async () => {
      const { deps, state, queued } = makeDeps({ remote: true });
      await save(deps);
      deps.secrets.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
      await expect(
        updateComputerProviderSettings(deps, actor, { provider: "default", values: {} }),
      ).resolves.toMatchObject({ provider: "default" });
      expect(state.settings?.computerProviderCipher).toBeNull();
      expect([...queued.values()]).toEqual([expect.objectContaining({ payload: replaced })]);
    });

    it("keeps the save's own failure when the unsaved connection cannot be removed either", async () => {
      const { deps, prisma, queued } = makeDeps({ remote: true });
      prisma.deploymentSettings.upsert.mockRejectedValueOnce(new Error("database unavailable"));
      deps.secrets.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
      await expect(save(deps)).rejects.toThrow("database unavailable");
      expect([...queued.values()]).toEqual([expect.objectContaining({ payload: replaced })]);
      await expect(retrySecretCleanup(deps, replaced)).resolves.toBeUndefined();
      expect(deps.secrets.delete).toHaveBeenCalledTimes(2);
    });

    it("never deletes a connection that is in use again", async () => {
      const { deps, state } = makeDeps({ remote: true });
      await save(deps);
      deps.secrets.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
      await save(deps, "ecd-other");
      state.settings = { computerProvider: "desktop", computerProviderCipher: "secret-1" };
      deps.secrets.delete.mockClear();
      await retrySecretCleanup(deps, replaced);
      expect(deps.secrets.delete).not.toHaveBeenCalled();
      expect(state.secrets.has("secret-1")).toBe(true);
    });

    it("leaves a failing retry to the queue", async () => {
      const { deps } = makeDeps({ remote: true });
      deps.secrets.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
      await expect(retrySecretCleanup(deps, replaced)).rejects.toThrow("secret store unavailable");
    });
  });

  it("reports the selected provider as the sandbox only with a saved connection", () => {
    expect(effectiveSandboxProvider(null, "docker")).toBe("docker");
    expect(
      effectiveSandboxProvider(
        { computerProvider: "desktop", computerProviderCipher: null },
        "none",
      ),
    ).toBe("none");
    expect(
      effectiveSandboxProvider(
        { computerProvider: "desktop", computerProviderCipher: "c" },
        "none",
      ),
    ).toBe("desktop");
  });
});

type SecretRow = { id: string; userId: string; spaceId: string | null; kind: string };

/** An in-memory secret table that filters the way the account settings query it. */
function makeAccountDeps(sandboxProvider = "docker", remote = false) {
  const { deps, state, queued } = makeDeps({ admin: false, remote });
  const rows: SecretRow[] = [];
  const matches = (row: SecretRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "not" in value
        ? row[key as keyof SecretRow] !== value.not
        : value && typeof value === "object" && "in" in value
          ? (value.in as unknown[]).includes(row[key as keyof SecretRow])
          : row[key as keyof SecretRow] === value,
    );
  const secret = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      rows.some((row) => row.id === where.id) ? { ciphertext: where.id } : null,
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const row = rows.findLast((candidate) => matches(candidate, where));
      return row ? { id: row.id, ciphertext: row.id } : null;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows
        .filter((candidate) => matches(candidate, where))
        .map((row) => ({ id: row.id, ciphertext: row.id })),
    ),
    create: vi.fn(async ({ data }: { data: SecretRow }) => {
      rows.push({ id: data.id, userId: data.userId, spaceId: data.spaceId, kind: data.kind });
      return data;
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const before = rows.length;
      rows.splice(0, rows.length, ...rows.filter((row) => !matches(row, where)));
      return { count: before - rows.length };
    }),
  };
  Object.assign(deps.prisma, { secret });
  deps.env.sandboxProvider = sandboxProvider;
  return { deps, state, rows, queued };
}

describe("an account's own computer", () => {
  const other = { userId: "user-2", spaceId: "space-1", email: "other@example.com" } as never;

  it("offers no providers and refuses one unless the deployment enables computer settings", async () => {
    const { deps, rows } = makeAccountDeps();
    deps.env.computerSettingsEnabled = false;
    await expect(getAccountComputerSettings(deps, actor)).resolves.toMatchObject({ providers: [] });
    await expect(
      updateAccountComputerSettings(deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("This deployment cannot use account computer settings");
    await expect(
      updateAccountComputerSettings(deps, actor, { provider: "default", values: {} }),
    ).resolves.toMatchObject({ provider: "default", providers: [] });
    expect(rows).toEqual([]);
  });

  it("lets any account save its own desktop, kept to that account", async () => {
    const { deps, rows } = makeAccountDeps();
    expect(await getAccountComputerSettings(deps, actor)).toMatchObject({
      provider: "default",
      defaultProvider: "docker",
      values: {},
      savedSecrets: {},
    });
    const saved = await updateAccountComputerSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    expect(deps.verifyConnection).toHaveBeenCalledOnce();
    expect(saved).toMatchObject({
      provider: "desktop",
      defaultProvider: "docker",
      values: { desktopId: "ecd-test" },
      savedSecrets: { accessKeyId: true, accessKeySecret: true, mcpToken: true },
    });
    expect(JSON.stringify(saved)).not.toContain("test-secret");
    // Account-level, so it outlives any one space and no teammate can read it.
    expect(rows).toEqual([
      { id: "secret-1", userId: "user-1", spaceId: null, kind: "computer-provider" },
    ]);
    expect(await getAccountComputerSettings(deps, actor)).toEqual(saved);
    expect((await getAccountComputerSettings(deps, other)).provider).toBe("default");
  });

  it("replaces the saved desktop, keeping blank secrets", async () => {
    const { deps, state, rows } = makeAccountDeps();
    await updateAccountComputerSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    await updateAccountComputerSettings(deps, actor, {
      provider: "desktop",
      values: { ...testDesktop, desktopId: "ecd-other", accessKeySecret: "", mcpToken: "" },
    });
    expect(rows.map((row) => row.id)).toEqual(["secret-2"]);
    expect(deps.secrets.delete).toHaveBeenCalledWith("secret-1", "secret-1");
    expect(JSON.parse(state.secrets.get("secret-2") ?? "").values).toMatchObject({
      desktopId: "ecd-other",
      accessKeySecret: "test-secret",
      mcpToken: "test-token",
    });
  });

  it("goes back to the deployment default by removing the saved desktop", async () => {
    const { deps, rows } = makeAccountDeps();
    await updateAccountComputerSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    await updateAccountComputerSettings(deps, other, {
      provider: "desktop",
      values: testDesktop,
    });
    const back = await updateAccountComputerSettings(deps, actor, {
      provider: "default",
      values: {},
    });
    expect(back).toMatchObject({ provider: "default", defaultProvider: "docker", values: {} });
    expect(rows.map((row) => row.userId)).toEqual(["user-2"]);
    expect(deps.secrets.delete).toHaveBeenCalledWith("secret-1", "secret-1");
    expect(deps.secrets.delete).not.toHaveBeenCalledWith("secret-2", "secret-2");
  });

  it("refuses unreachable desktops and deployments that never route by Settings", async () => {
    const { deps, rows } = makeAccountDeps();
    deps.verifyConnection.mockRejectedValueOnce(new Error("ConnectionRefused"));
    await expect(
      updateAccountComputerSettings(deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("Could not verify computer settings");
    expect(rows).toEqual([]);
    const local = makeAccountDeps("desktop");
    await expect(
      updateAccountComputerSettings(local.deps, actor, {
        provider: "desktop",
        values: testDesktop,
      }),
    ).rejects.toThrow("This deployment cannot use account computer settings");
    // Without computers, an account's private computers would have nowhere to run.
    const none = makeAccountDeps("none");
    await expect(
      updateAccountComputerSettings(none.deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("This deployment cannot use account computer settings");
    expect(await getAccountComputerSettings(none.deps, actor)).toMatchObject({ providers: [] });
  });

  it("removes the new keys when saving an account's desktop fails", async () => {
    const { deps, rows } = makeAccountDeps();
    (
      deps.prisma as unknown as { secret: { create: ReturnType<typeof vi.fn> } }
    ).secret.create.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      updateAccountComputerSettings(deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("database unavailable");
    expect(rows).toEqual([]);
    expect(deps.secrets.delete).toHaveBeenCalledWith("secret-1", "secret-1");
  });

  it("retries removing an account's replaced keys from a remote secret store", async () => {
    const { deps, rows, queued } = makeAccountDeps("docker", true);
    const replaced = { kind: "secret_row", recordId: "secret-1", ref: "secret-1" } as const;
    await updateAccountComputerSettings(deps, actor, { provider: "desktop", values: testDesktop });
    deps.secrets.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
    await expect(
      updateAccountComputerSettings(deps, actor, {
        provider: "desktop",
        values: { ...testDesktop, desktopId: "ecd-other" },
      }),
    ).resolves.toMatchObject({ provider: "desktop", values: { desktopId: "ecd-other" } });
    expect(rows.map((row) => row.id)).toEqual(["secret-2"]);
    expect(deps.jobs.enqueueIn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ payload: replaced, availableAt: expect.any(Date) }),
    );
    const [job] = [...queued.values()];
    expect(job).toMatchObject({ name: "secret.cleanup", payload: replaced });
    expect(job).not.toHaveProperty("availableAt");

    await retrySecretCleanup(deps, replaced);
    expect(deps.secrets.delete).toHaveBeenLastCalledWith(
      "secret-1",
      expect.objectContaining({ recordId: "secret-1" }),
    );
    // The keys now in use are never the retry's to delete.
    deps.secrets.delete.mockClear();
    await retrySecretCleanup(deps, { kind: "secret_row", recordId: "secret-2", ref: "secret-2" });
    expect(deps.secrets.delete).not.toHaveBeenCalled();
  });

  it("keeps an account save's own failure when the unsaved keys cannot be removed either", async () => {
    const { deps, queued } = makeAccountDeps("docker", true);
    (
      deps.prisma as unknown as { secret: { create: ReturnType<typeof vi.fn> } }
    ).secret.create.mockRejectedValueOnce(new Error("database unavailable"));
    deps.secrets.delete.mockRejectedValueOnce(new Error("secret store unavailable"));
    await expect(
      updateAccountComputerSettings(deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("database unavailable");
    expect([...queued.values()]).toEqual([
      expect.objectContaining({
        name: "secret.cleanup",
        payload: { kind: "secret_row", recordId: "secret-1", ref: "secret-1" },
      }),
    ]);
  });

  it("lets an account remove its saved desktop after the deployment stops offering one", async () => {
    const { deps, rows } = makeAccountDeps();
    await updateAccountComputerSettings(deps, actor, { provider: "desktop", values: testDesktop });
    deps.env.sandboxProvider = "none";
    expect((await getAccountComputerSettings(deps, actor)).providers.length).toBeGreaterThan(0);
    await updateAccountComputerSettings(deps, actor, { provider: "default", values: {} });
    expect(rows).toEqual([]);
  });
});

// The same API sanitization checks cover every settings-configurable adapter.
it.each(computerProviderDescriptors())(
  "stores $id settings without echoing any credentials",
  async (descriptor) => {
    const { deps } = makeDeps();
    const values = Object.fromEntries(
      descriptor.fields
        .filter((field) => field.required)
        .map((field) => [
          field.key,
          field.kind === "url" ? "https://gateway.example.com/mcp" : "example-value",
        ]),
    );
    const saved = await updateComputerProviderSettings(deps, actor, {
      provider: descriptor.id,
      values,
    });
    for (const field of descriptor.fields) {
      if (field.kind === "secret") {
        expect(saved.values).not.toHaveProperty(field.key);
        expect(saved.savedSecrets[field.key]).toBe(true);
      }
    }
    expect(await getComputerProviderSettings(deps, actor)).toEqual(saved);
  },
);

it("answers a provider this build does not have with a client error and saves nothing", async () => {
  const unknown = { provider: "a-provider-since-removed", values: { apiKey: "test-key" } };
  const refusal = {
    name: "ClientError",
    kind: "BAD_REQUEST",
    message: "Unknown computer provider",
  };
  const deployment = makeDeps();
  await expect(
    updateComputerProviderSettings(deployment.deps, actor, unknown),
  ).rejects.toMatchObject(refusal);
  expect(deployment.deps.secrets.put).not.toHaveBeenCalled();
  expect(deployment.state.settings).toBeNull();
  const account = makeAccountDeps();
  await expect(updateAccountComputerSettings(account.deps, actor, unknown)).rejects.toMatchObject(
    refusal,
  );
  expect(account.deps.secrets.put).not.toHaveBeenCalled();
  expect(account.rows).toEqual([]);
});

it("reads saved settings for a provider this build does not have as the default", async () => {
  const stored = JSON.stringify({ provider: "a-provider-since-removed", values: { apiKey: "k" } });
  const deployment = makeDeps();
  deployment.state.secrets.set("secret-old", stored);
  deployment.state.settings = {
    computerProvider: "a-provider-since-removed",
    computerProviderCipher: "secret-old",
  };
  const shown = await getComputerProviderSettings(deployment.deps, actor);
  expect(shown).toMatchObject({ provider: "default", values: {}, savedSecrets: {} });
  expect(shown.providers.map((provider) => provider.id)).not.toContain("a-provider-since-removed");
  const account = makeAccountDeps();
  account.rows.push({
    id: "secret-old",
    userId: "user-1",
    spaceId: null,
    kind: "computer-provider",
  });
  account.state.secrets.set("secret-old", stored);
  await expect(getAccountComputerSettings(account.deps, actor)).resolves.toMatchObject({
    provider: "default",
    values: {},
  });
});

it("rejects deployment-only providers for accounts", async () => {
  const { deps } = makeAccountDeps();
  await expect(
    updateAccountComputerSettings(deps, actor, {
      provider: "test-cloud",
      values: { apiKey: "test-key" },
    }),
  ).rejects.toThrow("Could not verify");
});

it("refuses a gateway resolving to a private address before using credentials", async () => {
  const { deps } = makeDeps();
  deps.resolveHostname.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  await expect(
    updateComputerProviderSettings(deps, actor, { provider: "desktop", values: testDesktop }),
  ).rejects.toThrow("Could not verify");
  expect(deps.verifyConnection).not.toHaveBeenCalled();
  expect(deps.secrets.put).not.toHaveBeenCalled();
});

it("retains previous deployment connections when changing providers", async () => {
  const { deps, state } = makeDeps();
  await updateComputerProviderSettings(deps, actor, {
    provider: "desktop",
    values: testDesktop,
  });
  await updateComputerProviderSettings(deps, actor, {
    provider: "test-cloud",
    values: { apiKey: "test-key" },
  });
  const stored = JSON.parse(state.secrets.get(state.settings!.computerProviderCipher!)!);
  expect(stored).toMatchObject({
    provider: "test-cloud",
    connections: { desktop: testDesktop },
  });
});

vi.mock(
  "../../../packages/adapters/src/computer-provider-registry.js",
  () =>
    import(
      "../../../packages/adapters/src/providers/computer/fake/fake-computer-settings.test-support.js"
    ),
);
