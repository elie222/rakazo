import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDeps } from "./voice.js";
import { mountVoiceHttpRoutes, persistVoiceCredential, voiceCredentialPlaintext } from "./voice.js";

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;

afterEach(() => vi.restoreAllMocks());

describe("voice HTTP routes answering a typed client error", () => {
  it.each([
    ["BAD_REQUEST", 400],
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["CONFLICT", 409],
    ["TOO_MANY_REQUESTS", 429],
    ["SERVICE_UNAVAILABLE", 503],
  ] as const)("answers %s with its own status and message", async (kind, status) => {
    const refusal = new ClientError(kind, "Written for the person");
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
    await expect(response.json()).resolves.toEqual({ error: "Written for the person" });
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

  it("lets a failure that is not the provider's through as a fault", async () => {
    const fault = new Error("database gone");

    await expect(save(fault)).rejects.toBe(fault);
  });
});
