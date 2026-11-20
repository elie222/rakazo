import type { SecretStore } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { serializeModelSecret } from "../models/model-secret.js";
import type { VoiceKeyDeps } from "./voice-model-connection.js";
import {
  modelConnectionVoiceSecret,
  parseModelConnectionVoiceSecret,
  resolveVoiceKey,
} from "./voice-model-connection.js";

const scope = { userId: "user-1", spaceId: "space-1" };

function credential(id: string, updatedAt: number, provider = "xai") {
  return {
    id,
    userId: scope.userId,
    provider,
    label: id,
    secretId: `secret-${id}`,
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
  };
}

function deps(options: {
  credentials?: ReturnType<typeof credential>[];
  secrets?: Record<string, string>;
}) {
  const secrets = options.secrets ?? {};
  const prisma = {
    $transaction: vi.fn(),
    userModelPreference: { findMany: vi.fn(async () => []) },
    userModelCredential: { findMany: vi.fn(async () => options.credentials ?? []) },
    secret: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id in secrets ? { id: where.id, ciphertext: `cipher:${where.id}` } : null,
      ),
    },
  };
  const secretStore: Pick<SecretStore, "load" | "put" | "delete"> = {
    load: vi.fn(async (_ref: string, context: Parameters<SecretStore["load"]>[1]) => {
      const id = typeof context === "string" ? context : context.recordId;
      return secrets[id] ?? "";
    }),
    put: vi.fn(),
    delete: vi.fn(),
  };
  return { prisma, secretStore, deps: { prisma, secretStore } as unknown as VoiceKeyDeps };
}

describe("resolveVoiceKey", () => {
  it("returns a stored key unchanged without reading the model connection", async () => {
    const { prisma, deps: d } = deps({});
    await expect(resolveVoiceKey(d, scope, "xai", "xai-own-voice-key")).resolves.toBe(
      "xai-own-voice-key",
    );
    expect(prisma.userModelCredential.findMany).not.toHaveBeenCalled();
    expect(prisma.secret.findFirst).not.toHaveBeenCalled();
  });

  it("treats the marker as a pasted key for a provider that cannot use the model connection", async () => {
    const { prisma, deps: d } = deps({});
    await expect(resolveVoiceKey(d, scope, "openai", modelConnectionVoiceSecret())).resolves.toBe(
      modelConnectionVoiceSecret(),
    );
    expect(prisma.userModelCredential.findMany).not.toHaveBeenCalled();
  });

  it("uses the API key of the newest xAI model connection", async () => {
    const { deps: d } = deps({
      credentials: [credential("old", 1_000), credential("new", 2_000)],
      secrets: { "secret-old": "xai-old-model-key", "secret-new": "xai-new-model-key" },
    });
    await expect(resolveVoiceKey(d, scope, "xai", modelConnectionVoiceSecret())).resolves.toBe(
      "xai-new-model-key",
    );
  });

  it("refuses a linked OpenRouter connection set to zero data retention", async () => {
    const { deps: d } = deps({
      credentials: [credential("zdr", 1_000, "openrouter")],
      secrets: {
        "secret-zdr": serializeModelSecret({
          kind: "api_key",
          key: "openrouter-zdr-key",
          zeroDataRetention: true,
        }),
      },
    });
    await expect(
      resolveVoiceKey(d, scope, "openrouter", modelConnectionVoiceSecret()),
    ).rejects.toBeInstanceOf(VoiceAccountError);
  });

  it("uses a linked OpenRouter connection without zero data retention", async () => {
    const { deps: d } = deps({
      credentials: [credential("plain", 1_000, "openrouter")],
      secrets: {
        "secret-plain": serializeModelSecret({ kind: "api_key", key: "openrouter-key" }),
      },
    });
    await expect(
      resolveVoiceKey(d, scope, "openrouter", modelConnectionVoiceSecret()),
    ).resolves.toBe("openrouter-key");
  });

  it("refuses a model connection the deployment allowlist leaves out", async () => {
    vi.stubEnv("RAKAZO_MODEL_PROVIDER_ALLOWLIST", "openrouter");
    try {
      const { prisma, deps: d } = deps({
        credentials: [credential("new", 2_000)],
        secrets: { "secret-new": "xai-new-model-key" },
      });
      await expect(
        resolveVoiceKey(d, scope, "xai", modelConnectionVoiceSecret()),
      ).rejects.toBeInstanceOf(VoiceAccountError);
      expect(prisma.secret.findFirst).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // A due refresh takes a Postgres advisory lock and calls the provider, so only a current
  // sign-in is covered here.
  it("uses the access token of a current Grok sign-in", async () => {
    const secret = serializeModelSecret({
      kind: "oauth",
      credential: {
        type: "oauth",
        access: "grok-access-token",
        refresh: "grok-refresh-token",
        expires: Date.now() + 60 * 60_000,
      },
    } as Parameters<typeof serializeModelSecret>[0]);
    const { prisma, deps: d } = deps({
      credentials: [credential("signin", 1_000)],
      secrets: { "secret-signin": secret },
    });
    await expect(resolveVoiceKey(d, scope, "xai", modelConnectionVoiceSecret())).resolves.toBe(
      "grok-access-token",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["no model connection", {}],
    ["a model connection whose secret is gone", { credentials: [credential("gone", 1_000)] }],
    [
      "a model connection that needs reconnecting",
      {
        credentials: [credential("retired", 1_000)],
        secrets: {
          "secret-retired": serializeModelSecret({ kind: "oauth", reconnectRequired: true }),
        },
      },
    ],
  ])("asks to connect xAI in Models settings for %s", async (_name, options) => {
    const { deps: d } = deps(options);
    const error = await resolveVoiceKey(d, scope, "xai", modelConnectionVoiceSecret()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(VoiceAccountError);
    expect(error).toMatchObject({ code: undefined, message: "Connect xAI in Models settings." });
  });
});

describe("parseModelConnectionVoiceSecret", () => {
  it("reads the link, including one saved before a connection could be chosen", () => {
    expect(parseModelConnectionVoiceSecret(modelConnectionVoiceSecret("model-1"))).toEqual({
      credentialId: "model-1",
    });
    // Rows saved by the first release hold exactly this string.
    expect(parseModelConnectionVoiceSecret('{"kind":"model_connection"}')).toEqual({});
  });

  it("treats anything else as a pasted key", () => {
    for (const key of [
      "xai-test-key",
      '{"kind":"model_connection","credentialId":42}',
      '{"kind":"model_connection",',
      ' {"kind":"model_connection"}',
      '{"kind":"api_key"}',
      '{"kind":"model_connection","note":"a pasted key"}',
      '{"kind":"model_connection","credentialId":"model-1","note":"a pasted key"}',
      '{"credentialId":"model-1","kind":"model_connection"}',
    ]) {
      expect(parseModelConnectionVoiceSecret(key)).toBeUndefined();
    }
  });
});
