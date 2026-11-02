import type { SandboxProvider } from "@rakazo/adapter-kit";
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

const wuying = {
  desktopId: "ecd-test",
  endUserId: "test-user",
  mcpUrl: "https://gateway.example.com/mcp",
  accessKeyId: "test-id",
  accessKeySecret: "test-secret",
  mcpToken: "test-token",
};

/** An in-memory deployment settings row and secret table behind the calls the config makes. */
function makeDeps(options: { admin?: boolean } = {}) {
  const state = {
    settings: null as null | {
      computerProvider: string | null;
      computerProviderSecretId: string | null;
    },
    secrets: new Map<string, string>(),
  };
  let nextSecret = 0;
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ email: "admin@example.com", emailVerified: true })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => state.settings),
      upsert: vi.fn(async ({ update }: { update: Record<string, string | null> }) => {
        state.settings = {
          computerProvider: null,
          computerProviderSecretId: null,
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
    },
    sandbox: { describe: () => ({ id: "docker" }) } as unknown as SandboxProvider,
    env: {
      sandboxProvider: "docker",
      adminEmails: options.admin === false ? [] : ["admin@example.com"],
    },
    verifyWuying: vi.fn(async () => undefined),
  };
  return { deps, state, prisma };
}

describe("computer provider settings", () => {
  it("is for admins only", async () => {
    const { deps } = makeDeps({ admin: false });
    await expect(getComputerProviderSettings(deps, actor)).rejects.toThrow("Admins only");
    await expect(
      updateComputerProviderSettings(deps, actor, { provider: "wuying", wuying }),
    ).rejects.toThrow("Admins only");
  });

  it("checks the desktop, stores the connection encrypted and never returns secrets", async () => {
    const { deps, state } = makeDeps();
    const saved = await updateComputerProviderSettings(deps, actor, { provider: "wuying", wuying });
    expect(deps.verifyWuying).toHaveBeenCalledOnce();
    expect(state.settings).toMatchObject({ computerProvider: "wuying" });
    expect(saved).toEqual({
      provider: "wuying",
      defaultProvider: "docker",
      wuying: {
        regionId: "cn-hangzhou",
        desktopId: "ecd-test",
        endUserId: "test-user",
        mcpUrl: "https://gateway.example.com/mcp",
        hasAccessKey: true,
        hasMcpToken: true,
      },
    });
    expect(JSON.stringify(saved)).not.toContain("test-secret");
    expect(await getComputerProviderSettings(deps, actor)).toEqual(saved);
  });

  it("keeps saved secrets when their fields are left blank", async () => {
    const { deps, state } = makeDeps();
    await updateComputerProviderSettings(deps, actor, { provider: "wuying", wuying });
    await updateComputerProviderSettings(deps, actor, {
      provider: "wuying",
      wuying: { ...wuying, desktopId: "ecd-other", accessKeySecret: "", mcpToken: "" },
    });
    const current = state.secrets.get(state.settings?.computerProviderSecretId ?? "") ?? "";
    expect(JSON.parse(current)).toMatchObject({
      desktopId: "ecd-other",
      accessKeySecret: "test-secret",
      mcpToken: "test-token",
    });
    // The replaced secret row is removed.
    expect(state.secrets.size).toBe(1);
  });

  it("sends the saved token only to the gateway it was saved for", async () => {
    const { deps } = makeDeps();
    await updateComputerProviderSettings(deps, actor, { provider: "wuying", wuying });
    await expect(
      updateComputerProviderSettings(deps, actor, {
        provider: "wuying",
        wuying: { ...wuying, mcpUrl: "https://other.example.com/mcp", mcpToken: "" },
      }),
    ).rejects.toThrow("mcpToken is required");
    expect(deps.verifyWuying).toHaveBeenCalledTimes(1);
  });

  it("refuses incomplete or unreachable settings without saving", async () => {
    const { deps, state } = makeDeps();
    await expect(
      updateComputerProviderSettings(deps, actor, {
        provider: "wuying",
        wuying: { ...wuying, mcpToken: "" },
      }),
    ).rejects.toThrow("mcpToken is required");
    deps.verifyWuying.mockRejectedValueOnce(new Error("InvalidAccessKeyId"));
    await expect(
      updateComputerProviderSettings(deps, actor, { provider: "wuying", wuying }),
    ).rejects.toThrow("Could not reach the Wuying desktop: InvalidAccessKeyId");
    expect(state.settings).toBeNull();
  });

  it("switches back without dropping the saved connection", async () => {
    const { deps, state } = makeDeps();
    await updateComputerProviderSettings(deps, actor, { provider: "wuying", wuying });
    const back = await updateComputerProviderSettings(deps, actor, { provider: "default" });
    expect(back.provider).toBe("default");
    expect(back.wuying?.desktopId).toBe("ecd-test");
    expect(state.settings?.computerProvider).toBeNull();
    expect(state.secrets.size).toBe(1);
  });

  it("reports an account's own desktop over the deployment's provider", () => {
    expect(effectiveSandboxProvider(null, "docker", true)).toBe("wuying");
    // Those deployments never route computers by Settings.
    expect(effectiveSandboxProvider(null, "desktop", true)).toBe("desktop");
  });

  it("reports Wuying as the sandbox only with a saved connection", () => {
    expect(effectiveSandboxProvider(null, "docker")).toBe("docker");
    expect(
      effectiveSandboxProvider(
        { computerProvider: "wuying", computerProviderSecretId: null },
        "none",
      ),
    ).toBe("none");
    expect(
      effectiveSandboxProvider(
        { computerProvider: "wuying", computerProviderSecretId: "s" },
        "none",
      ),
    ).toBe("wuying");
  });
});

type SecretRow = { id: string; userId: string; spaceId: string | null; kind: string };

/** An in-memory secret table that filters the way the account settings query it. */
function makeAccountDeps(sandboxProvider = "docker") {
  const { deps, state } = makeDeps({ admin: false });
  const rows: SecretRow[] = [];
  const matches = (row: SecretRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "not" in value
        ? row[key as keyof SecretRow] !== value.not
        : row[key as keyof SecretRow] === value,
    );
  const secret = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const row = rows.findLast((candidate) => matches(candidate, where));
      return row ? { id: row.id, ciphertext: row.id } : null;
    }),
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
  return { deps, state, rows };
}

describe("an account's own computer", () => {
  const other = { userId: "user-2", spaceId: "space-1", email: "other@example.com" } as never;

  it("lets any account save its own desktop, kept to that account", async () => {
    const { deps, rows } = makeAccountDeps();
    expect(await getAccountComputerSettings(deps, actor)).toEqual({
      provider: "default",
      defaultProvider: "docker",
      wuying: null,
    });
    const saved = await updateAccountComputerSettings(deps, actor, { provider: "wuying", wuying });
    expect(deps.verifyWuying).toHaveBeenCalledOnce();
    expect(saved).toMatchObject({
      provider: "wuying",
      defaultProvider: "docker",
      wuying: { desktopId: "ecd-test", hasAccessKey: true, hasMcpToken: true },
    });
    expect(JSON.stringify(saved)).not.toContain("test-secret");
    // Account-level, so it outlives any one space and no teammate can read it.
    expect(rows).toEqual([
      { id: "secret-1", userId: "user-1", spaceId: null, kind: "wuying-computer" },
    ]);
    expect(await getAccountComputerSettings(deps, actor)).toEqual(saved);
    expect((await getAccountComputerSettings(deps, other)).provider).toBe("default");
  });

  it("replaces the saved desktop, keeping blank secrets", async () => {
    const { deps, state, rows } = makeAccountDeps();
    await updateAccountComputerSettings(deps, actor, { provider: "wuying", wuying });
    await updateAccountComputerSettings(deps, actor, {
      provider: "wuying",
      wuying: { ...wuying, desktopId: "ecd-other", accessKeySecret: "", mcpToken: "" },
    });
    expect(rows.map((row) => row.id)).toEqual(["secret-2"]);
    expect(JSON.parse(state.secrets.get("secret-2") ?? "")).toMatchObject({
      desktopId: "ecd-other",
      accessKeySecret: "test-secret",
      mcpToken: "test-token",
    });
  });

  it("goes back to the deployment default by removing the saved desktop", async () => {
    const { deps, rows } = makeAccountDeps();
    await updateAccountComputerSettings(deps, actor, { provider: "wuying", wuying });
    await updateAccountComputerSettings(deps, other, { provider: "wuying", wuying });
    const back = await updateAccountComputerSettings(deps, actor, { provider: "default" });
    expect(back).toEqual({ provider: "default", defaultProvider: "docker", wuying: null });
    expect(rows.map((row) => row.userId)).toEqual(["user-2"]);
  });

  it("refuses unreachable desktops and deployments that never route by Settings", async () => {
    const { deps, rows } = makeAccountDeps();
    deps.verifyWuying.mockRejectedValueOnce(new Error("InvalidAccessKeyId"));
    await expect(
      updateAccountComputerSettings(deps, actor, { provider: "wuying", wuying }),
    ).rejects.toThrow("Could not reach the Wuying desktop: InvalidAccessKeyId");
    expect(rows).toEqual([]);
    const local = makeAccountDeps("desktop");
    await expect(
      updateAccountComputerSettings(local.deps, actor, { provider: "wuying", wuying }),
    ).rejects.toThrow("This deployment cannot use Wuying computers");
  });
});
