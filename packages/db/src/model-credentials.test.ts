import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  chooseModelCredential,
  defaultModelCredentialCandidates,
  findModelCredential,
  newestModelCredentialOrder,
  saveSpaceModelPreference,
} from "./model-credentials.js";

describe("findModelCredential", () => {
  it("falls back to the newest user credential when the space has no preference", async () => {
    const preferenceFindFirst = vi.fn().mockResolvedValue(null);
    const credentialFindFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: credentialFindFirst },
    } as unknown as PrismaClient;

    await findModelCredential(prisma, { userId: "user", spaceId: "space" }, "xai");

    expect(preferenceFindFirst).toHaveBeenCalledWith({
      where: { userId: "user", spaceId: "space", credential: { provider: "xai" } },
      include: { credential: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    expect(credentialFindFirst).toHaveBeenCalledWith({
      where: { userId: "user", provider: "xai" },
      orderBy: newestModelCredentialOrder,
    });
  });

  it("prefers the preference that owns a free-form modelId over the provider default", async () => {
    const matching = {
      credential: {
        id: "credential-other",
        userId: "user",
        provider: "openai-compatible",
        label: "Other",
        secretId: "secret-other",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      modelId: "other-model",
    };
    const preferenceFindFirst = vi.fn().mockResolvedValue(matching);
    const prisma = {
      spaceModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      findModelCredential(
        prisma,
        { userId: "user", spaceId: "space" },
        "openai-compatible",
        "other-model",
      ),
    ).resolves.toEqual({
      ...matching.credential,
      defaultModel: "other-model",
    });
    expect(preferenceFindFirst).toHaveBeenCalledWith({
      where: {
        userId: "user",
        spaceId: "space",
        modelId: "other-model",
        credential: { provider: "openai-compatible" },
      },
      include: { credential: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    expect(preferenceFindFirst).toHaveBeenCalledTimes(1);
  });

  it("uses chooseModelCredential when the client can list every candidate", async () => {
    const older = {
      id: "credential-older",
      userId: "user",
      provider: "openai-codex",
      label: "Older",
      secretId: "secret-older",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const newer = {
      id: "credential-newer",
      userId: "user",
      provider: "openai-codex",
      label: "Newer",
      secretId: "secret-newer",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      updatedAt: new Date("2026-02-02T00:00:00.000Z"),
    };
    const sparkPreference = {
      id: "pref-spark",
      modelId: "gpt-5.3-codex-spark",
      thinkingLevel: null,
      updatedAt: new Date("2026-02-03T00:00:00.000Z"),
      credential: older,
    };
    const defaultPreference = {
      id: "pref-default",
      modelId: "gpt-6-luna",
      thinkingLevel: null,
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      credential: newer,
    };
    const preferenceFindMany = vi.fn().mockResolvedValue([defaultPreference, sparkPreference]);
    const credentialFindMany = vi.fn().mockResolvedValue([older, newer]);
    const prisma = {
      spaceModelPreference: { findMany: preferenceFindMany },
      userModelCredential: { findMany: credentialFindMany },
    } as unknown as PrismaClient;

    await expect(
      findModelCredential(
        prisma,
        { userId: "user", spaceId: "space" },
        "openai-codex",
        "gpt-5.3-codex-spark",
      ),
    ).resolves.toEqual({
      ...older,
      defaultModel: "gpt-5.3-codex-spark",
      thinkingLevel: null,
    });
    await expect(
      findModelCredential(
        prisma,
        { userId: "user", spaceId: "space" },
        "openai-codex",
        "gpt-6-luna",
      ),
    ).resolves.toEqual({
      ...newer,
      defaultModel: "gpt-6-luna",
      thinkingLevel: null,
    });
  });
});

describe("chooseModelCredential", () => {
  function credential(id: string, iso: string) {
    const at = new Date(iso);
    return {
      id,
      provider: "openai-codex",
      secretId: `secret-${id}`,
      updatedAt: at,
      createdAt: at,
    };
  }

  it("prefers the preference that owns the model id over the default", () => {
    const apiKey = credential("api", "2026-01-01T00:00:00.000Z");
    const oauth = credential("oauth", "2026-03-01T00:00:00.000Z");
    const choice = chooseModelCredential({
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
      preferences: [
        {
          id: "pref-default",
          modelId: "gpt-6-luna",
          thinkingLevel: null,
          updatedAt: new Date("2026-03-02T00:00:00.000Z"),
          credential: oauth,
        },
        {
          id: "pref-spark",
          modelId: "gpt-5.3-codex-spark",
          thinkingLevel: null,
          updatedAt: new Date("2026-02-01T00:00:00.000Z"),
          credential: apiKey,
        },
      ],
      credentials: [oauth, apiKey],
    });
    expect(choice).toEqual({
      source: "preference",
      preference: expect.objectContaining({ credential: apiKey }),
    });
  });

  it("prefers the space preference over a newer unused credential", () => {
    const older = credential("older", "2026-01-01T00:00:00.000Z");
    const newer = credential("newer", "2026-02-01T00:00:00.000Z");
    const candidates = defaultModelCredentialCandidates({
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      preferences: [
        {
          id: "pref-older",
          modelId: "gpt-5.4",
          thinkingLevel: null,
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          credential: older,
        },
      ],
      credentials: [newer, older],
    });
    expect(candidates.map((item) => item.id)).toEqual(["older", "newer"]);
  });

  it("keeps the model owner as the only default candidate", () => {
    const apiKey = credential("api", "2026-01-01T00:00:00.000Z");
    const oauth = credential("oauth", "2026-03-01T00:00:00.000Z");
    const candidates = defaultModelCredentialCandidates({
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
      preferences: [
        {
          id: "pref-spark",
          modelId: "gpt-5.3-codex-spark",
          thinkingLevel: null,
          updatedAt: new Date("2026-02-01T00:00:00.000Z"),
          credential: apiKey,
        },
        {
          id: "pref-luna",
          modelId: "gpt-6-luna",
          thinkingLevel: null,
          updatedAt: new Date("2026-03-02T00:00:00.000Z"),
          credential: oauth,
        },
      ],
      credentials: [oauth, apiKey],
    });
    expect(candidates.map((item) => item.id)).toEqual(["api"]);
  });

  it("lists the latest space preference before a credential that owns another model", () => {
    const apiKey = credential("api", "2026-01-01T00:00:00.000Z");
    const oauth = credential("oauth", "2026-03-01T00:00:00.000Z");
    const candidates = defaultModelCredentialCandidates({
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      preferences: [
        {
          id: "pref-spark",
          modelId: "gpt-5.3-codex-spark",
          thinkingLevel: null,
          updatedAt: new Date("2026-03-03T00:00:00.000Z"),
          credential: apiKey,
        },
        {
          id: "pref-other",
          modelId: "gpt-5.4",
          thinkingLevel: null,
          updatedAt: new Date("2026-03-02T00:00:00.000Z"),
          credential: oauth,
        },
      ],
      credentials: [apiKey, oauth],
    });
    expect(candidates.map((item) => item.id)).toEqual(["api", "oauth"]);
  });

  it("still offers the only credential when its preference owns a different model", () => {
    const apiKey = credential("api", "2026-01-01T00:00:00.000Z");
    const candidates = defaultModelCredentialCandidates({
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      preferences: [
        {
          id: "pref-spark",
          modelId: "gpt-5.3-codex-spark",
          thinkingLevel: null,
          updatedAt: apiKey.updatedAt,
          credential: apiKey,
        },
      ],
      credentials: [apiKey],
    });
    expect(candidates.map((item) => item.id)).toEqual(["api"]);
  });

  it("keeps the newest account credential when the space has no preference", () => {
    const older = credential("older", "2026-01-01T00:00:00.000Z");
    const newest = credential("newest", "2026-04-01T00:00:00.000Z");
    expect(
      chooseModelCredential({
        provider: "openai-codex",
        modelId: "gpt-5.3-codex-spark",
        preferences: [],
        credentials: [older, newest],
      }),
    ).toEqual({ source: "credential", credential: newest });
  });
});

describe("saveSpaceModelPreference", () => {
  it.each([null, undefined, "null", "undefined", "  null  ", ""])(
    "does not persist %j as a model id",
    async (modelId) => {
      const upsert = vi.fn().mockResolvedValue({ id: "preference" });
      const prisma = { spaceModelPreference: { upsert } } as unknown as PrismaClient;

      await saveSpaceModelPreference(
        prisma,
        { userId: "user", spaceId: "space" },
        "credential",
        modelId,
      );

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ modelId: null }),
          update: { modelId: null, thinkingLevel: null },
        }),
      );
    },
  );
});

it.each([
  ["azure", "azure-openai-responses"],
  ["azure-openai-responses", "azure"],
])("resolves %s through a saved %s credential and preference", async (provider, storedProvider) => {
  const credential = {
    id: "credential-azure",
    provider: storedProvider,
    userId: "user",
    label: "Azure",
    secretId: "secret-azure",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const preference = {
    id: "pref-azure",
    modelId: "gpt-4o",
    thinkingLevel: null,
    updatedAt: new Date(0),
    credential,
  };
  const findPreferences = vi.fn().mockResolvedValue([preference]);
  const findCredentials = vi.fn().mockResolvedValue([credential]);
  const prisma = {
    spaceModelPreference: { findMany: findPreferences },
    userModelCredential: { findMany: findCredentials },
  } as unknown as PrismaClient;
  expect(
    await findModelCredential(prisma, { userId: "user", spaceId: "space" }, provider, "gpt-4o"),
  ).toMatchObject({ id: credential.id, defaultModel: "gpt-4o" });
  expect(findCredentials).toHaveBeenCalledWith({
    where: { userId: "user", provider: { in: ["azure", "azure-openai-responses"] } },
  });
  expect(
    chooseModelCredential({
      provider,
      modelId: "gpt-4o",
      preferences: [],
      credentials: [credential],
    }),
  ).toEqual({ source: "credential", credential });
  expect(
    defaultModelCredentialCandidates({
      provider,
      modelId: "gpt-4o",
      preferences: [preference],
      credentials: [credential],
    }),
  ).toEqual([credential]);
});
