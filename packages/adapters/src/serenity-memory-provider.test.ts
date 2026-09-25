import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifySerenityConnectionSettings,
  createSerenityProvider,
  MemoryProviderDeploymentOwnerRequiredError,
  prepareSerenityConnection,
  SerenityMemoryProvider,
  sanitizeSerenityBrainLabel,
  serenityBotEntity,
  serenityRequiresDeploymentOwner,
  serenitySpaceEntity,
} from "./serenity-memory-provider.js";

/** Stable digest suffix for "Personal Brain" (case-folded). */
const PERSONAL_BRAIN = "personal-brain-7a024bf3";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

vi.mock("./serenity-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./serenity-client.js")>();
  return {
    ...actual,
    probeSerenity: vi.fn(),
    recallSerenity: vi.fn(),
    rememberSerenity: vi.fn(),
    forgetSerenity: vi.fn(),
  };
});

import {
  forgetSerenity,
  probeSerenity,
  recallSerenity,
  rememberSerenity,
} from "./serenity-client.js";

const probeSerenityMock = vi.mocked(probeSerenity);
const recallSerenityMock = vi.mocked(recallSerenity);
const rememberSerenityMock = vi.mocked(rememberSerenity);
const forgetSerenityMock = vi.mocked(forgetSerenity);

afterEach(() => {
  vi.clearAllMocks();
});

function provider(allowWrites = true, brainLabel = "") {
  return new SerenityMemoryProvider({
    endpoint: "http://127.0.0.1:8787/mcp",
    token: "serenity_test_token",
    brainLabel,
    allowWrites,
  });
}

describe("SerenityMemoryProvider", () => {
  it("keeps labeled entities to the single type/slug shape Serenity accepts", () => {
    for (const entity of [
      serenityBotEntity("bot-1", "Personal Brain"),
      serenitySpaceEntity("workspace-1", "Personal Brain"),
    ]) {
      expect(entity.split("/")).toHaveLength(2);
    }
  });

  it("keeps bot and space entity namespaces inside the adapter", () => {
    expect(serenityBotEntity("bot-1")).toBe("rakazo-bot/bot-1");
    expect(serenitySpaceEntity("workspace-1")).toBe("rakazo-space/workspace-1");
    expect(serenityBotEntity("bot-1", "Personal Brain")).toBe(
      `rakazo-bot/${PERSONAL_BRAIN}--bot-1`,
    );
    expect(serenitySpaceEntity("workspace-1", "Personal Brain")).toBe(
      `rakazo-space/${PERSONAL_BRAIN}--workspace-1`,
    );
  });

  it("isolates labels that sanitize to the same slug", () => {
    const spaced = sanitizeSerenityBrainLabel("prod brain");
    const hyphenated = sanitizeSerenityBrainLabel("prod-brain");
    expect(spaced).toBe("prod-brain-886a332f");
    expect(hyphenated).toBe("prod-brain-0691dd31");
    expect(spaced).not.toBe(hyphenated);
    expect(serenityBotEntity("bot-1", "prod brain")).not.toBe(
      serenityBotEntity("bot-1", "prod-brain"),
    );
  });

  it("requires deployment owner for loopback, private DNS, and classified LAN hosts", () => {
    expect(serenityRequiresDeploymentOwner({ endpoint: "http://127.0.0.1:8787/mcp" })).toBe(true);
    expect(serenityRequiresDeploymentOwner({ endpoint: "https://serenity.internal/mcp" })).toBe(
      true,
    );
    expect(serenityRequiresDeploymentOwner({ endpoint: "https://serenity.example.test/mcp" })).toBe(
      false,
    );
    expect(
      serenityRequiresDeploymentOwner({
        endpoint: "https://serenity.example.test/mcp",
        endpointTrust: "private",
      }),
    ).toBe(true);
  });

  it("requires an explicit endpoint and does not assume a hosted URL", async () => {
    await expect(
      prepareSerenityConnection({ allowWrites: "false" }, { token: "serenity_test_token" }),
    ).rejects.toThrow("endpoint is required");
    expect(probeSerenityMock).not.toHaveBeenCalled();
  });

  it("classifies private LAN DNS without probing", async () => {
    const classified = await classifySerenityConnectionSettings(
      { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
      {
        resolveHostname: async () => [{ address: "10.8.0.2", family: 4 as const }],
      },
    );
    expect(classified.endpointTrust).toBe("private");
    expect(serenityRequiresDeploymentOwner(classified)).toBe(true);
    expect(probeSerenityMock).not.toHaveBeenCalled();
  });

  it("refuses private endpoints before probing when allowPrivateEndpoint is false", async () => {
    await expect(
      prepareSerenityConnection(
        { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
        { token: "serenity_test_token" },
        {
          resolveHostname: async () => [{ address: "10.8.0.2", family: 4 as const }],
        },
        { allowPrivateEndpoint: false },
      ),
    ).rejects.toBeInstanceOf(MemoryProviderDeploymentOwnerRequiredError);
    expect(probeSerenityMock).not.toHaveBeenCalled();
  });

  it("stores private endpointTrust when HTTPS LAN DNS resolves privately", async () => {
    probeSerenityMock.mockResolvedValue({ ok: true, value: undefined });
    const prepared = await prepareSerenityConnection(
      { endpoint: "https://serenity.example.test/mcp", allowWrites: "false" },
      { token: "serenity_test_token" },
      {
        resolveHostname: async () => [{ address: "10.8.0.2", family: 4 as const }],
      },
    );
    expect(prepared.settings.endpointTrust).toBe("private");
    expect(serenityRequiresDeploymentOwner(prepared.settings)).toBe(true);
  });

  it("probes before accepting a connection", async () => {
    probeSerenityMock.mockResolvedValue({ ok: true, value: undefined });
    const prepared = await prepareSerenityConnection(
      { endpoint: "http://127.0.0.1:8787", allowWrites: "false", brainLabel: "personal" },
      { token: "serenity_test_token" },
    );
    expect(prepared.settings.endpoint).toBe("http://127.0.0.1:8787/mcp");
    expect(prepared.settings.allowWrites).toBe("false");
    expect(prepared.credentials).toEqual({ token: "serenity_test_token" });
    expect(probeSerenityMock).toHaveBeenCalledOnce();
  });

  it("recalls isolated scope only against the bot entity", async () => {
    recallSerenityMock.mockResolvedValue({
      ok: true,
      value: [
        {
          factId: "fact-1",
          fact: "Prefer conventional commits.",
          provenance: "user told rakazo",
        },
      ],
    });

    const result = await provider().recall(
      { query: "commits", scope: "isolated", botId: "bot-1", limit: 5 },
      context,
    );

    expect(result).toEqual({
      ok: true,
      value: [
        {
          memory: "Prefer conventional commits.",
          score: 1,
          id: "fact-1",
          provenance: "user told rakazo",
          entity: "rakazo-bot/bot-1",
        },
      ],
    });
    expect(recallSerenityMock).toHaveBeenCalledWith(
      "commits",
      expect.objectContaining({ endpoint: "http://127.0.0.1:8787/mcp" }),
      expect.objectContaining({ entity: "rakazo-bot/bot-1", limit: 5 }),
    );
  });

  it("writes shared durable saves once, to the space entity", async () => {
    rememberSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-2", status: "inserted" },
    });

    const result = await provider().save(
      {
        content: "Use metric units.",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );

    expect(result).toEqual({ ok: true, value: undefined });
    expect(rememberSerenityMock.mock.calls.map((call) => call[3]?.entity)).toEqual([
      "rakazo-space/workspace-1",
    ]);
  });

  it("writes isolated durable saves to the bot entity", async () => {
    rememberSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-2", status: "inserted" },
    });
    await provider().save(
      {
        content: "Use metric units.",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );
    expect(rememberSerenityMock.mock.calls.map((call) => call[3]?.entity)).toEqual([
      "rakazo-bot/bot-1",
    ]);
  });

  it("keys retried saves within a run so Serenity replays instead of duplicating", async () => {
    rememberSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-2", status: "inserted" },
    });
    const request = {
      content: "Use metric units.",
      scope: "isolated" as const,
      botId: "bot-1",
      source: { kind: "durable" as const },
    };
    const run = { ...context, runId: "run-1" };
    await provider().save(request, { ...run, operationId: "op-1" });
    await provider().save(request, { ...run, operationId: "op-2" });
    await provider().save({ ...request, content: "Use imperial units." }, run);
    const keys = rememberSerenityMock.mock.calls.map((call) => call[3]?.operationKey);
    expect(keys[0]).toMatch(/^rakazo:[0-9a-f]{48}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("scopes shared durable saves by brain label when configured", async () => {
    rememberSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-2", status: "inserted" },
    });

    const labeled = new SerenityMemoryProvider({
      endpoint: "http://127.0.0.1:8787/mcp",
      token: "serenity_test_token",
      brainLabel: "Personal Brain",
      allowWrites: true,
    });
    await labeled.save(
      {
        content: "Use metric units.",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );

    expect(rememberSerenityMock.mock.calls.map((call) => call[3]?.entity)).toEqual([
      `rakazo-space/${PERSONAL_BRAIN}--workspace-1`,
    ]);
  });

  it("forgets by fact id only (Serenity forget has no entity argument)", async () => {
    forgetSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-9", expired: true, reason: null },
    });

    const labeled = new SerenityMemoryProvider({
      endpoint: "http://127.0.0.1:8787/mcp",
      token: "serenity_test_token",
      brainLabel: "Personal Brain",
      allowWrites: true,
    });
    await labeled.forget(
      { id: "fact-9", entity: `rakazo-bot/${PERSONAL_BRAIN}--bot-1`, reason: "cleanup" },
      context,
    );
    expect(forgetSerenityMock).toHaveBeenCalledWith(
      "fact-9",
      expect.objectContaining({ brainLabel: "Personal Brain" }),
      expect.objectContaining({ reason: "cleanup" }),
    );
    expect(forgetSerenityMock.mock.calls[0]?.[2]).not.toHaveProperty("entity");
  });

  it("blocks durable writes when allowWrites is off", async () => {
    const result = await provider(false).save(
      {
        content: "Use metric units.",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );
    expect(result.ok).toBe(false);
    expect(rememberSerenityMock).not.toHaveBeenCalled();
  });

  it("skips history compaction writes and purges", async () => {
    await expect(
      provider().save(
        {
          content: "summary",
          scope: "isolated",
          botId: "bot-1",
          source: { kind: "history", generation: 3 },
        },
        context,
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      provider().purgeHistory({ botId: "bot-1", generations: [1, 2] }, context),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(rememberSerenityMock).not.toHaveBeenCalled();
  });

  it("keeps recall entity citations without forwarding them to Serenity forget", async () => {
    recallSerenityMock
      .mockResolvedValueOnce({
        ok: true,
        value: [
          {
            factId: "fact-space-1",
            fact: "The team uses metric units.",
            provenance: "space policy",
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        value: [],
      });
    forgetSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-space-1", expired: true, reason: null },
    });

    const labeled = new SerenityMemoryProvider({
      endpoint: "http://127.0.0.1:8787/mcp",
      token: "serenity_test_token",
      brainLabel: "Personal Brain",
      allowWrites: true,
    });
    const recalled = await labeled.recall(
      { query: "units", scope: "shared", botId: "bot-1", limit: 5 },
      context,
    );
    expect(recalled).toEqual({
      ok: true,
      value: [
        {
          memory: "The team uses metric units.",
          score: 1,
          id: "fact-space-1",
          provenance: "space policy",
          entity: `rakazo-space/${PERSONAL_BRAIN}--workspace-1`,
        },
      ],
    });

    const fact = recalled.ok ? recalled.value[0] : undefined;
    await labeled.forget({ id: fact!.id!, entity: fact!.entity, reason: "cleanup" }, context);
    expect(forgetSerenityMock).toHaveBeenCalledWith(
      "fact-space-1",
      expect.objectContaining({ brainLabel: "Personal Brain" }),
      expect.objectContaining({ reason: "cleanup" }),
    );
    expect(forgetSerenityMock.mock.calls[0]?.[2]).not.toHaveProperty("entity");
  });

  it("forgets by Serenity fact id when writes are enabled", async () => {
    forgetSerenityMock.mockResolvedValue({
      ok: true,
      value: { id: "fact-1", expired: true, reason: "user requested" },
    });
    const result = await provider().forget({ id: "fact-1", reason: "user requested" }, context);
    expect(result).toEqual({
      ok: true,
      value: { id: "fact-1", expired: true, reason: "user requested" },
    });
  });

  it("createSerenityProvider builds a working adapter", () => {
    const created = createSerenityProvider(
      { endpoint: "https://serenity.example.test/mcp", allowWrites: "true" },
      { token: "serenity_test_token" },
    );
    expect(created.describe().id).toBe("serenity");
  });
});
