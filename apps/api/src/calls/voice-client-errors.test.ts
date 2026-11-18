import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDeps } from "./voice.js";
import { mountVoiceHttpRoutes, persistVoiceCredential, voiceCredentialPlaintext } from "./voice.js";

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;

afterEach(() => vi.restoreAllMocks());

describe("voice HTTP routes answering a typed client error", () => {
  it.each([
    ["BAD_REQUEST", 400, undefined],
    ["UNAUTHORIZED", 401, undefined],
    ["FORBIDDEN", 403, undefined],
    ["NOT_FOUND", 404, undefined],
    ["CONFLICT", 409, undefined],
    ["TOO_MANY_REQUESTS", 429, undefined],
    ["SERVICE_UNAVAILABLE", 503, undefined],
    ["FORBIDDEN", 403, "AI_CONSENT_REQUIRED"],
  ] as const)("answers %s with its own status and message", async (kind, status, code) => {
    const refusal = new ClientError(kind, "Written for the person", code);
    const deps = {
      prisma: { spaceSettingOverride: { findUnique: vi.fn().mockRejectedValue(refusal) } },
    } as unknown as VoiceDeps;
    const app = new Hono();
    mountVoiceHttpRoutes(app, deps, async () => actor);

    const response = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: "Written for the person",
      ...(code ? { code } : {}),
    });
  });
});

describe("voice HTTP routes reporting what they answer", () => {
  afterEach(() => installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] })));

  async function speak(refusal: ClientError) {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const deps = {
      prisma: { spaceSettingOverride: { findUnique: vi.fn().mockRejectedValue(refusal) } },
    } as unknown as VoiceDeps;
    const app = new Hono();
    mountVoiceHttpRoutes(app, deps, async () => actor);
    await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });
    return sink.events;
  }

  it("reports an outage with what caused it, and says nothing about a refusal", async () => {
    class KeyServiceDown extends Error {
      override name = "KeyServiceDown";
    }
    const outage = new ClientError("SERVICE_UNAVAILABLE", "Try again shortly.", undefined, {
      cause: new KeyServiceDown("unreachable"),
    });
    expect(await speak(outage)).toEqual([
      expect.objectContaining({
        level: "error",
        message: "voice request unavailable",
        reason: "KeyServiceDown",
      }),
    ]);
    expect(await speak(new ClientError("BAD_REQUEST", "Written for the person"))).toEqual([]);
  });
});

describe("a self-hosted voice server's form", () => {
  const form = { provider: "openai-compatible", allowPrivateEndpoint: true, plaintext: "" };

  it("refuses an address that is not a URL as a bad request, in the same words", () => {
    expect(() => voiceCredentialPlaintext({ ...form, baseUrl: "not a url" })).toThrow(
      expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Base URL must be an absolute HTTP(S) URL",
      }),
    );
  });

  it("names the transcription server when its address is the one refused", () => {
    expect(() =>
      voiceCredentialPlaintext({
        ...form,
        baseUrl: "http://100.64.0.10:8810",
        sttBaseUrl: "ftp://100.64.0.11",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Transcription server URL: Base URL must use http or https",
      }),
    );
  });

  it("lets a failure that is not about the form through as a fault", () => {
    const fault = new Error("stored settings could not be merged");
    vi.spyOn(adapters, "serializeOpenAiCompatibleVoiceSecret").mockImplementation(() => {
      throw fault;
    });

    let thrown: unknown;
    try {
      voiceCredentialPlaintext({ ...form, baseUrl: "http://100.64.0.10:8810" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(fault);
  });
});

describe("saving a voice connection linked to the model connection", () => {
  const save = (failure: unknown) => {
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ verify: vi.fn() } as never);
    vi.spyOn(adapters, "resolveVoiceKey").mockRejectedValueOnce(failure);
    const deps = { prisma: {}, secrets: {} } as unknown as VoiceDeps;
    return persistVoiceCredential(deps, actor, { provider: "xai", plaintext: "" });
  };

  it.each([
    ["times out", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
    [
      "is refused by the provider",
      new Error("OAuth refresh failed for xai", {
        cause: Object.assign(new Error('{"error":"invalid_grant"}'), { status: 400 }),
      }),
    ],
    [
      "cannot reach the provider",
      new Error("OAuth refresh failed for xai", { cause: new Error("socket hang up") }),
    ],
  ])("explains a renewal that %s without quoting the provider", async (_case, failure) => {
    await expect(save(failure)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Couldn't use the xAI connection from Models. Try again.",
    });
  });

  it("answers a failure it does not recognise the same way, quoting nothing from it", async () => {
    const failure = new RangeError('provider said {"access_token":"abc123"}', {
      cause: new Error("Authorization: Bearer abc123"),
    });

    const thrown = (await save(failure).catch((error: unknown) => error)) as Error;

    expect(thrown).toMatchObject({
      code: "BAD_REQUEST",
      message: "Couldn't use the xAI connection from Models. Try again.",
    });
    expect(thrown.cause).toBeUndefined();
  });

  it("answers a secret store outage as one to wait out", async () => {
    const outage = new SecretStoreUnavailableError();

    await expect(save(outage)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      cause: outage,
    });
  });

  it("lets a database outage through as itself, so the request is retried", async () => {
    const outage = Object.assign(new Error("Can't reach database server"), { code: "P1001" });

    await expect(save(outage)).rejects.toBe(outage);
  });
});
