import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMemoryProviderSettings } from "./memory-provider-factory.js";
import type { MemoryProviderId } from "./memory-providers.js";
import { memoryProviders } from "./memory-providers.js";

const ctx = {
  operationId: "memory",
  traceId: "memory",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

/** Saved connections for the shared suite. Nothing here reaches a real server. */
interface MemoryConformanceFixture {
  /** Settings and credentials as prepare saves them, for a server on a public address. */
  settings: Record<string, string>;
  credentials: Record<string, string>;
  /** The settings for a server the operator runs at this address. */
  selfHosted(server: string): Record<string, string>;
  /** From a self-hosted connection, another value for every field that scopes the credentials. */
  elsewhere: Record<string, string>;
}

const LAN_SERVER = "https://192.168.1.20";
const PUBLIC_SERVER = "https://memory.example.com";
/** A public-looking name whose DNS answer is a private address. */
const REBOUND_SERVER = "https://rebound.example.com";
/** Nothing listens on port 1, so a request is refused at once without leaving this machine. */
const CLOSED_SERVER = "http://127.0.0.1:1";
const OTHER_SERVER = "https://memory.example.org";
const key = { apiKey: "test-memory-key" };

/** Keyed by every provider id, so a provider without an offline fixture fails typecheck. */
const fixtures: Record<MemoryProviderId, MemoryConformanceFixture> = {
  supermemory: {
    settings: { mode: "cloud" },
    credentials: key,
    selfHosted: (baseUrl) => ({ mode: "local", baseUrl }),
    elsewhere: { mode: "cloud", baseUrl: OTHER_SERVER },
  },
  serenity: {
    settings: { endpoint: `${PUBLIC_SERVER}/mcp`, allowWrites: "true" },
    credentials: { token: "test-memory-token" },
    selfHosted: (server) => ({ endpoint: `${server}/mcp`, allowWrites: "true" }),
    elsewhere: { endpoint: `${OTHER_SERVER}/mcp` },
  },
  honcho: {
    settings: { mode: "cloud", workspaceId: "workspace-1" },
    credentials: key,
    selfHosted: (baseUrl) => ({ mode: "local", baseUrl, workspaceId: "workspace-1" }),
    elsewhere: {
      mode: "cloud",
      baseUrl: OTHER_SERVER,
      workspaceId: "workspace-2",
      userPeerId: "peer-2",
    },
  },
  hindsight: {
    settings: { mode: "cloud" },
    credentials: key,
    selfHosted: (baseUrl) => ({ mode: "local", baseUrl }),
    elsewhere: { mode: "cloud", baseUrl: OTHER_SERVER, recallBanks: "other-bank" },
  },
};

/** DNS answers for the suite: the rebound name is private, every other name public. */
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => [
    { address: hostname.startsWith("rebound.") ? "10.0.0.5" : "203.0.113.10", family: 4 },
  ]),
}));

/** Any request fails the test: the suite never needs a server. */
function blockNetwork() {
  const fetch = vi.fn(async () => {
    throw new TypeError("fetch failed");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ids = Object.keys(fixtures) as MemoryProviderId[];

describe.each(ids)("%s memory conformance", (id) => {
  const definition = memoryProviders[id];
  const fixture = fixtures[id];

  it("accepts its saved settings and names the connection", () => {
    expect(() => assertMemoryProviderSettings(id, fixture.settings)).not.toThrow();
    expect(definition.settings.connectionLabel(fixture.settings).trim()).not.toBe("");
  });

  it("builds an adapter that describes itself and versions its connection", () => {
    const provider = definition.create(fixture.settings, fixture.credentials, "version-1");
    const { id: described, capabilities } = provider.describe();
    expect(described).toBe(id);
    expect(capabilities).toMatchObject({
      recall: true,
      save: true,
      purgeHistory: true,
      sharedScope: true,
    });
    if (provider.retainConversation) {
      const other = definition.create(fixture.settings, fixture.credentials, "version-2");
      expect(provider.connectionIdentity).toBeTruthy();
      expect(other.connectionIdentity).not.toBe(provider.connectionIdentity);
    }
  });

  it("needs the operator's consent only for a server on a private address", () => {
    expect(definition.requiresPrivateEndpoint(fixture.settings)).toBe(false);
    expect(definition.requiresPrivateEndpoint(fixture.selfHosted(LAN_SERVER))).toBe(true);
    expect(definition.requiresPrivateEndpoint(fixture.selfHosted(CLOSED_SERVER))).toBe(true);
  });

  it("decides consent by the address a self-hosted server resolves to", async () => {
    const fetch = blockNetwork();
    const needsConsent = async (server: string) =>
      definition.requiresPrivateEndpoint(
        (await definition.classifySettings?.(fixture.selfHosted(server))) ??
          fixture.selfHosted(server),
      );
    expect(await needsConsent(PUBLIC_SERVER)).toBe(false);
    expect(await needsConsent(LAN_SERVER)).toBe(true);
    expect(await needsConsent(CLOSED_SERVER)).toBe(true);
    expect(await needsConsent(REBOUND_SERVER)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a private server without consent before sending anything", async () => {
    const fetch = blockNetwork();
    for (const server of [LAN_SERVER, REBOUND_SERVER]) {
      await expect(
        definition.prepare(fixture.selfHosted(server), fixture.credentials, {
          allowPrivateEndpoint: false,
        }),
      ).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("moves the credential target when any field that scopes the credentials changes", () => {
    const scoping = definition.settings.fields
      .filter((field) => field.scopesSecrets)
      .map((field) => field.key);
    expect(Object.keys(fixture.elsewhere).sort()).toEqual(scoping.sort());
    const settings = fixture.selfHosted(PUBLIC_SERVER);
    const target = definition.credentialTarget(settings);
    expect(definition.credentialTarget({ ...settings })).toBe(target);
    for (const [key, value] of Object.entries(fixture.elsewhere)) {
      expect(definition.credentialTarget({ ...settings, [key]: value }), key).not.toBe(target);
    }
  });

  it("answers with a failure, not an exception, when its server cannot be reached", async () => {
    blockNetwork();
    const provider = definition.create(
      fixture.selfHosted(CLOSED_SERVER),
      fixture.credentials,
      "version-1",
    );
    const recalled = await provider.recall(
      { query: "favourite colour", scope: "isolated", botId: "bot-1", limit: 5 },
      ctx,
    );
    expect(recalled.ok).toBe(false);
    const saved = await provider.save(
      {
        content: "Likes green.",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      ctx,
    );
    expect(saved.ok).toBe(false);
  });
});
