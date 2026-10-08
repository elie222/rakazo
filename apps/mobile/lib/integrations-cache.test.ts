import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationsCacheScope } from "./integrations-cache";
import {
  integrationsCacheScope,
  isIntegrationsScopeCurrent,
  persistedIntegrationsCacheScope,
  readIntegrationsCache,
  writeIntegrationsCache,
} from "./integrations-cache";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  base: "https://api.example.test",
  space: "space-a",
  generation: 0,
  rpc: vi.fn(),
  broken: false,
  saved: vi.fn(),
  save: vi.fn(),
}));
vi.mock("./api", () => ({
  currentApiBase: () => state.base,
  selectedSpaceId: () => state.space,
  rpc: state.rpc,
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  loadVerifiedIntegrationsScope: state.saved,
  saveVerifiedIntegrationsScope: state.save,
}));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    get exists() {
      return true;
    }
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    create() {}
  }
  class File extends Directory {
    override get exists() {
      return state.files.has(this.uri);
    }
    override create() {
      if (state.broken) throw new Error("disk unavailable");
    }
    textSync() {
      return state.files.get(this.uri);
    }
    write(value: string) {
      state.files.set(this.uri, value);
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});
const scope: IntegrationsCacheScope = {
  apiBase: "https://api.example.test",
  userId: "user-a",
  spaceId: "space-a",
  sessionGeneration: 0,
  selectionId: "space-a",
};
const snapshot = {
  catalog: [
    {
      connectorId: "test",
      slug: "example",
      name: "Example",
      logo: "https://example.test/logo.svg",
      connected: true,
      noAuth: false,
    },
  ],
  connections: [
    {
      id: "connection-a",
      connectorId: "test",
      provider: "example",
      displayName: "Example",
      status: "connected" as const,
      capabilities: [],
      createdAt: "2026-01-01",
    },
  ],
};

beforeEach(() => {
  state.files.clear();
  state.base = scope.apiBase;
  state.space = scope.spaceId;
  state.generation += 1;
  state.broken = false;
  state.saved.mockReset().mockResolvedValue(null);
  state.save.mockReset().mockResolvedValue(undefined);
  state.rpc.mockReset().mockResolvedValue({ userId: "user-a", spaceId: "space-a" });
});

describe("integration disk cache", () => {
  it("round trips catalog artwork and Added accounts, including local mutations", () => {
    expect(readIntegrationsCache(scope)).toBeNull();
    writeIntegrationsCache(scope, snapshot);
    expect(readIntegrationsCache(scope)).toEqual(snapshot);
    const next = {
      ...snapshot,
      connections: [
        { ...snapshot.connections[0]!, displayName: "Renamed", status: "revoked" as const },
      ],
    };
    writeIntegrationsCache(scope, next);
    expect(readIntegrationsCache(scope)).toEqual(next);
  });
  it.each([
    { userId: "user-b" },
    { spaceId: "space-b" },
    { apiBase: "https://other.example.test" },
  ])("never reads another scope %j", (change) => {
    writeIntegrationsCache(scope, snapshot);
    expect(readIntegrationsCache({ ...scope, ...change })).toBeNull();
  });
  it("treats corrupt files, mismatched keys, invalid rows, and disk failures as misses", () => {
    writeIntegrationsCache(scope, snapshot);
    const path = [...state.files.keys()][0]!;
    for (const value of [
      "{",
      JSON.stringify({ key: "wrong", ...snapshot }),
      JSON.stringify({
        key: JSON.stringify([scope.apiBase, scope.userId, scope.spaceId]),
        catalog: [{}],
        connections: [],
      }),
    ]) {
      state.files.set(path, value);
      expect(readIntegrationsCache(scope)).toBeNull();
    }
    state.broken = true;
    expect(() => writeIntegrationsCache(scope, snapshot)).not.toThrow();
  });
  it("reuses verified identity until the session changes", async () => {
    const first = await integrationsCacheScope();
    state.space = "space-b";
    expect((await integrationsCacheScope()).spaceId).toBe("space-b");
    expect(state.rpc).toHaveBeenCalledTimes(2);
    expect(isIntegrationsScopeCurrent(first)).toBe(false);
    state.generation += 1;
    state.rpc.mockResolvedValue({ userId: "user-b", spaceId: "space-b" });
    expect((await integrationsCacheScope()).userId).toBe("user-b");
    expect(state.rpc).toHaveBeenCalledTimes(3);
  });
  it.each(["session", "space"])(
    "rejects identity that returns after a %s change",
    async (change) => {
      let resolve!: (value: unknown) => void;
      state.rpc.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const pending = integrationsCacheScope();
      if (change === "session") state.generation += 1;
      else state.space = "space-b";
      resolve({ userId: "user-a", spaceId: "space-a" });
      await expect(pending).rejects.toThrow("Could not load integrations");
    },
  );
});

it("restores only the persisted verified scope without waiting for me", async () => {
  state.saved.mockResolvedValue(scope);
  state.rpc.mockReturnValue(new Promise(() => {}));
  writeIntegrationsCache(scope, snapshot);
  const restored = await persistedIntegrationsCacheScope();
  expect(restored).toEqual({ ...scope, sessionGeneration: state.generation });
  expect(readIntegrationsCache(restored!)).toEqual(snapshot);
  expect(state.rpc).not.toHaveBeenCalled();
});
it.each(["server", "space", "session"])(
  "rejects a persisted scope after %s changes",
  async (change) => {
    state.saved.mockImplementation(async () => {
      if (change === "server") state.base = "https://other.example.test";
      if (change === "space") state.space = "space-b";
      if (change === "session") state.generation += 1;
      return scope;
    });
    expect(await persistedIntegrationsCacheScope()).toBeNull();
  },
);
it("persists a scope only after successful identity verification", async () => {
  const verified = await integrationsCacheScope();
  expect(state.save).toHaveBeenCalledWith(state.generation, verified);
  state.generation += 1;
  state.rpc.mockRejectedValue(new Error("offline"));
  await expect(integrationsCacheScope()).rejects.toThrow("offline");
  expect(state.save).toHaveBeenCalledTimes(1);
});
