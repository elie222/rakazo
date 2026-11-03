import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ModelChoice } from "./model-choice.js";
import { matchModelChoice, resolveModelChoice } from "./model-choice.js";

const choice = (provider: string, providerName: string, id: string, label: string) => ({
  provider,
  providerName,
  id,
  label,
});

const choices: ModelChoice[] = [
  choice("anthropic", "Anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
  choice("anthropic", "Anthropic", "claude-sonnet-5", "Claude Sonnet 5"),
  choice("anthropic", "Anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5"),
  choice("openrouter", "OpenRouter", "anthropic/claude-sonnet-5.5", "Anthropic: Claude Sonnet 5.5"),
  choice("google", "Google", "gemini-3.7-flash", "Gemini 3.7 Flash"),
  choice("google", "Google", "gemini-3.8-flash", "Gemini 3.8 Flash"),
  choice("google", "Google", "gemini-3.8-flash-lite", "Gemini 3.8 Flash Lite"),
];

const matched = (query: string, preferred?: string) => {
  const { match } = matchModelChoice(choices, query, preferred);
  return match && `${match.provider}/${match.id}`;
};

describe("matchModelChoice", () => {
  it("matches exact ids, with or without the provider", () => {
    expect(matched("claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(matched("OpenRouter/anthropic/claude-sonnet-5.5")).toBe(
      "openrouter/anthropic/claude-sonnet-5.5",
    );
  });

  it("reads a loose name as the newest plain model of that family", () => {
    expect(matched("Claude Sonnet")).toBe("anthropic/claude-sonnet-5-5");
    expect(matched("gemini flash")).toBe("google/gemini-3.8-flash");
    expect(matched("Gemini Flash Lite")).toBe("google/gemini-3.8-flash-lite");
  });

  it("keeps a spoken version exact", () => {
    expect(matched("sonnet 5")).toBe("anthropic/claude-sonnet-5");
    expect(matched("Gemini 3.7 Flash")).toBe("google/gemini-3.7-flash");
  });

  it("prefers the bot's current provider", () => {
    expect(matched("Claude Sonnet", "openrouter")).toBe("openrouter/anthropic/claude-sonnet-5.5");
  });

  it("returns ranked candidates instead of guessing between equal matches", () => {
    const twins = [
      choice("google", "Google", "gemini-3.8-flash", "Gemini 3.8 Flash"),
      choice("google-vertex", "Vertex", "gemini-3.8-flash", "Gemini 3.8 Flash"),
    ];
    const { match, ranked } = matchModelChoice(twins, "Gemini 3.8 Flash");
    expect(match).toBeUndefined();
    expect(ranked).toHaveLength(2);
  });

  it("matches nothing for an unknown name", () => {
    expect(matchModelChoice(choices, "llama").ranked).toEqual([]);
  });
});

function connected(providers: string[]) {
  const credentials = providers.map((provider) => ({
    id: `cred-${provider}`,
    provider,
    secretId: `secret-${provider}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
  const prisma = {
    userModelCredential: { findMany: vi.fn(async () => credentials) },
    userModelPreference: { findMany: vi.fn(async () => []) },
    secret: {
      findMany: vi.fn(async () =>
        credentials.map((credential) => ({ id: credential.secretId, ciphertext: "fake" })),
      ),
    },
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    secretStore: { load: async () => "fake-api-key" },
  };
}

const scope = { userId: "user-1", spaceId: "space-1" };

describe("resolveModelChoice", () => {
  it("resolves a loose name against the connected providers' models", async () => {
    expect(
      await resolveModelChoice(connected(["google"]), scope, { model: "gemini flash" }),
    ).toEqual({ ok: true, provider: "google", model: "gemini-3.8-flash" });
  });

  it("names the provider to connect when only another provider has the model", async () => {
    const result = await resolveModelChoice(connected(["google"]), scope, {
      model: "Claude Sonnet",
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/connect .*Anthropic.* in Settings first/),
    });
  });

  it("passes an exact provider/id through for the model check to judge", async () => {
    expect(
      await resolveModelChoice(connected(["google"]), scope, { model: "google/gemini-live-x" }),
    ).toEqual({ ok: true, provider: "google", model: "gemini-live-x" });
  });

  it("says when no model anywhere matches", async () => {
    expect(await resolveModelChoice(connected([]), scope, { model: "zzz-unknown" })).toEqual({
      ok: false,
      error: 'No model matches "zzz-unknown".',
    });
  });
});
