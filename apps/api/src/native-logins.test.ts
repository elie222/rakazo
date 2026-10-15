import type { SandboxProvider, SecretStore } from "@rakazo/adapter-kit";
import type { Actor, NativeLoginState } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createNativeLogins } from "./native-logins.js";

const actor = { spaceId: "space", userId: "user" } as Actor;
const input = {
  harness: "codex" as const,
  computerId: "computer",
  label: "Personal",
  region: "global" as const,
  selfHostedPersonalUse: true as const,
};
function fixture(enabled = true) {
  let serial = 0;
  const secrets = new Map<
    string,
    { id: string; ciphertext: string; userId: string; spaceId: null }
  >();
  const credentials = new Map<
    string,
    { id: string; label: string; provider: string; userId: string; secretId: string }
  >();
  const cleanup: unknown[] = [];
  let finish!: (state: NativeLoginState) => void;
  const completion = new Promise<NativeLoginState>((resolve) => {
    finish = resolve;
  });
  const cancel = vi.fn().mockResolvedValue(undefined);
  const start = vi.fn().mockResolvedValue({
    initial: {
      state: "pending",
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "ABCD",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    completion,
    cancel,
  });
  const inspect = vi.fn().mockResolvedValue({ state: "ready", accountLabel: null, plan: null });
  const logout = vi.fn().mockResolvedValue(undefined);
  const computer = {
    id: "computer",
    providerRef: "container",
    homeKey: "home",
    kind: "docker",
    spaceId: "space",
    userId: "user",
    scope: "team",
    bots: [],
  };
  const db = {
    computer: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === computer.id &&
        where.userId === computer.userId &&
        where.spaceId === computer.spaceId
          ? computer
          : null,
      ),
      findMany: vi.fn().mockResolvedValue([computer]),
    },
    secret: {
      findFirst: vi.fn(async ({ where }) => {
        const s = secrets.get(where.id);
        return s?.userId === where.userId ? s : null;
      }),
      create: vi.fn(async ({ data }) => {
        secrets.set(data.id, data);
        return data;
      }),
      deleteMany: vi.fn(async ({ where }) => {
        secrets.delete(where.id);
        return { count: 1 };
      }),
    },
    userModelCredential: {
      findFirst: vi.fn(async ({ where }) => {
        const c = credentials.get(where.id);
        return c?.userId === where.userId ? c : null;
      }),
      findMany: vi.fn(async () => [...credentials.values()]),
      create: vi.fn(async ({ data }) => {
        const c = { ...data, id: `account-${++serial}` };
        credentials.set(c.id, c);
        return { ...c };
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const c = credentials.get(where.id);
        if (!c || c.userId !== where.userId || c.secretId !== where.secretId) return { count: 0 };
        Object.assign(c, data);
        return { count: 1 };
      }),
    },
    nativeStateCleanup: {
      create: vi.fn(async ({ data }) => {
        cleanup.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn) => fn(db));
  const store = {
    put: vi.fn(async (plaintext: string) => ({ id: `secret-${++serial}`, ciphertext: plaintext })),
    load: vi.fn(async (ciphertext: string) => ciphertext),
  };
  const sandbox = { startProcess: vi.fn(), nativeStateInstallationId: () => "a".repeat(32) };
  const dependencies = {
    prisma: db as unknown as PrismaClient,
    secrets: store as unknown as SecretStore,
    sandbox: sandbox as unknown as SandboxProvider,
    selfHostedEnabled: enabled,
    start,
    inspect,
    logout,
  };
  const api = createNativeLogins(dependencies);
  return {
    api,
    newInstance: () => createNativeLogins(dependencies),
    db,
    start,
    cancel,
    finish,
    inspect,
    logout,
    credentials,
    secrets,
    cleanup,
  };
}

describe("owner-scoped native login lifecycle", () => {
  it("requires the explicit eligible self-hosted gate", async () => {
    const f = fixture(false);
    await expect(f.api.begin(actor, input)).rejects.toThrow("self-hosted");
    expect(f.start).not.toHaveBeenCalled();
  });
  it("rejects a computer outside the caller's space before allocating credentials", async () => {
    const f = fixture();
    await expect(f.api.begin({ ...actor, spaceId: "other" }, input)).rejects.toThrow("unavailable");
    expect(f.credentials.size).toBe(0);
  });
  it("returns only device instructions and persists a nonsecret descriptor", async () => {
    const f = fixture();
    const result = await f.api.begin(actor, input);
    expect(result.state.state).toBe("pending");
    expect(result).not.toHaveProperty("descriptor");
    expect(result).not.toHaveProperty("epoch");
    expect(JSON.parse([...f.secrets.values()][0]!.ciphertext)).toMatchObject({
      kind: "native_login",
      state: "pending",
      computerId: "computer",
      computerProviderRef: "container",
    });
    expect([...f.credentials.values()][0]?.provider).toBe("native-codex");
  });
  it("marks ready only after the isolated vendor flow completes", async () => {
    const f = fixture();
    const result = await f.api.begin(actor, input);
    f.finish({ state: "ready", accountLabel: null, plan: "personal" });
    await vi.waitFor(() =>
      expect(JSON.parse([...f.secrets.values()][0]!.ciphertext).state).toBe("ready"),
    );
    expect((await f.api.status(actor, result.credentialId)).state.state).toBe("ready");
  });
  it("invalidates before logout and atomically queues the old exact epoch", async () => {
    const f = fixture();
    const result = await f.api.begin(actor, input);
    const old = JSON.parse([...f.secrets.values()][0]!.ciphertext);
    await f.api.logout(actor, result.credentialId);
    const current = JSON.parse([...f.secrets.values()][0]!.ciphertext);
    expect(current.state).toBe("disconnected");
    expect(current.epoch).not.toBe(old.epoch);
    expect(f.cleanup[0]).toMatchObject({
      scope: {
        request: {
          expectedInstallationId: "a".repeat(32),
          credentialScope: { connectionId: old.connectionId, epoch: old.epoch },
        },
      },
    });
    expect(f.cancel).toHaveBeenCalledOnce();
    f.finish({ state: "ready", accountLabel: null, plan: null });
    await Promise.resolve();
    expect(JSON.parse([...f.secrets.values()][0]!.ciphertext).state).toBe("disconnected");
  });
  it("cannot inspect or cancel another owner's account", async () => {
    const f = fixture();
    const result = await f.api.begin(actor, input);
    await expect(
      f.api.status({ ...actor, userId: "other" }, result.credentialId),
    ).rejects.toThrow();
    await expect(
      f.api.cancel({ ...actor, spaceId: "other" }, result.credentialId),
    ).rejects.toThrow();
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it("still invalidates and queues cleanup when the original computer was deleted", async () => {
    const f = fixture();
    const result = await f.api.begin(actor, input);
    f.db.computer.findFirst.mockResolvedValue(null);
    await expect(f.api.logout(actor, result.credentialId)).resolves.toMatchObject({
      state: { state: "signed_out" },
    });
    expect(f.cleanup).toHaveLength(1);
  });
  it.each(["https://evil.example/device", "https://auth.openai.com:8443/device"])(
    "cancels malformed device instructions: %s",
    async (verificationUri) => {
      const f = fixture();
      f.start.mockResolvedValueOnce({
        initial: { state: "pending", verificationUri, userCode: "CODE", expiresAt: null },
        completion: new Promise(() => {}),
        cancel: f.cancel,
      });
      await expect(f.api.begin(actor, input)).rejects.toThrow("invalid device instructions");
      expect(f.cancel).toHaveBeenCalledOnce();
      expect(JSON.parse([...f.secrets.values()][0]!.ciphertext).state).toBe("disconnected");
      expect(f.cleanup).toHaveLength(1);
    },
  );
  it.each(["failed", "ready"] as const)(
    "does not revoke a reconnected epoch after stale %s completion on another API instance",
    async (state) => {
      const f = fixture();
      const old = await f.api.begin(actor, input);
      f.start.mockResolvedValueOnce({
        initial: {
          state: "pending",
          verificationUri: "https://auth.openai.com/codex/device",
          userCode: "NEW",
          expiresAt: null,
        },
        completion: new Promise(() => {}),
        cancel: vi.fn().mockResolvedValue(undefined),
      });
      const next = await f.newInstance().begin(actor, { ...input, credentialId: old.credentialId });
      const secretId = f.credentials.get(next.credentialId)!.secretId;
      const cleanupCount = f.cleanup.length;
      f.finish(
        state === "ready" ? { state, accountLabel: null, plan: null } : { state, code: "expired" },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.credentials.get(next.credentialId)!.secretId).toBe(secretId);
      expect(JSON.parse(f.secrets.get(secretId)!.ciphertext).state).toBe("pending");
      expect(f.cleanup).toHaveLength(cleanupCount);
    },
  );
  it("cancels a handle whose pending account was revoked while its startup awaited", async () => {
    const f = fixture();
    let release!: (handle: unknown) => void;
    f.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const starting = f.api.begin(actor, input);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    const credentialId = [...f.credentials.keys()][0]!;
    await f.newInstance().logout(actor, credentialId);
    const secretId = f.credentials.get(credentialId)!.secretId;
    release({
      initial: {
        state: "pending",
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: "STALE",
        expiresAt: null,
      },
      completion: new Promise(() => {}),
      cancel: f.cancel,
    });
    await expect(starting).rejects.toThrow("invalid device instructions");
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.credentials.get(credentialId)!.secretId).toBe(secretId);
    expect((await f.api.list(actor)).accounts[0]?.state.state).toBe("signed_out");
  });
});
