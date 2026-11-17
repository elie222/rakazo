import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import type * as Database from "@rakazo/db";
import { admitSpeech, settleSpeech } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDeps } from "../calls/voice.js";
import {
  effectiveVoiceStatus,
  loadDefaultVoiceCredential,
  loadVoiceCredential,
  synthesizeVoice,
  transcribeInboundVoice,
  transcribeVoice,
} from "../calls/voice.js";
import { deploymentVoiceFromEnv } from "./deployment-config.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Database>()),
  admitSpeech: vi.fn(async () => "speech-call"),
  settleSpeech: vi.fn(async () => {}),
}));

const price = {
  model: "speech-model",
  unit: "characters",
  microsPerUnit: 15,
  maxRequestMicros: 100000,
  source: "https://pricing.example/speech",
  version: "test-v1",
};
const config = {
  provider: "scripted",
  allowUnmeteredUsage: true,
  connection: { plaintext: "fake-server-key" },
  voiceId: "test-voice",
  pricing: { synthesize: price, transcribe: { ...price, unit: "seconds" } },
};
const actor = { userId: "test-user", spaceId: "test-space" } as Actor;
function deps(override = false, cred: unknown = null) {
  return {
    env: { deploymentVoice: deploymentVoiceFromEnv(JSON.stringify(config)) },
    prisma: {
      spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(override ? {} : null) },
      userVoicePreference: { findFirst: vi.fn().mockResolvedValue(cred) },
      spaceVoicePreference: { findFirst: vi.fn().mockResolvedValue(null) },
      userVoiceCredential: { findFirst: vi.fn().mockResolvedValue(null) },
      secret: { findFirst: vi.fn().mockResolvedValue(null) },
      speechAllowance: {
        findFirst: vi.fn().mockResolvedValue({ limitMicros: 1000000n, usedMicros: 0n }),
      },
    },
    secrets: { load: vi.fn() },
  } as unknown as VoiceDeps;
}
describe("deployment speech default", () => {
  it("is optional and rejects unsafe pricing without disclosing input", () => {
    expect(deploymentVoiceFromEnv(undefined)).toBeUndefined();
    expect(() =>
      deploymentVoiceFromEnv(
        JSON.stringify({ ...config, pricing: { synthesize: { ...price, maxRequestMicros: -1 } } }),
      ),
    ).toThrow("Invalid DEPLOYMENT_VOICE");
    expect(() => deploymentVoiceFromEnv("secret-invalid-json")).toThrow(
      /^Invalid DEPLOYMENT_VOICE connection or pricing policy$/,
    );
  });
  it("rejects a missing dedicated key and inconsistent fixed-model pricing", () => {
    expect(() =>
      deploymentVoiceFromEnv(JSON.stringify({ ...config, connection: { plaintext: " " } })),
    ).toThrow("Invalid DEPLOYMENT_VOICE");
    expect(() => deploymentVoiceFromEnv(JSON.stringify({ ...config, provider: "xai" }))).toThrow(
      "Invalid DEPLOYMENT_VOICE",
    );
  });
  it.each(["baseUrl", "sttBaseUrl", "sttApiKey"])(
    "rejects unsupported %s fields instead of disclosing an unused endpoint",
    (field) => {
      expect(() =>
        deploymentVoiceFromEnv(
          JSON.stringify({
            ...config,
            provider: "openai",
            connection: {
              plaintext: "fake-server-key",
              [field]: field === "sttApiKey" ? "fake-stt-key" : "https://unused.example.test",
            },
          }),
        ),
      ).toThrow("Invalid DEPLOYMENT_VOICE");
    },
  );
  it.each(["baseUrl", "sttBaseUrl"])(
    "rejects dispatch-incompatible %s at startup without exposing credentials",
    (field) => {
      for (const value of [
        "https://fake-user:fake-password@speech.example.test/v1",
        "http://speech.example.test/v1",
        "http://169.254.169.254/v1",
      ]) {
        expect(() =>
          deploymentVoiceFromEnv(
            JSON.stringify({
              ...config,
              provider: "openai-compatible",
              connection: {
                plaintext: "fake-server-key",
                baseUrl: "https://speech.example.test/v1",
                [field]: value,
                ...(field === "sttBaseUrl" ? { sttApiKey: "fake-stt-key" } : {}),
              },
            }),
            true,
          ),
        ).toThrow(/^Invalid DEPLOYMENT_VOICE connection or pricing policy$/);
      }
    },
  );
  it("uses the deployment's private-endpoint policy and validates the effective pricing models", () => {
    const privateConfig = {
      ...config,
      provider: "openai-compatible",
      connection: { plaintext: "fake-server-key", baseUrl: "http://127.0.0.1:8880/v1" },
    };
    expect(() => deploymentVoiceFromEnv(JSON.stringify(privateConfig))).toThrow(
      "Invalid DEPLOYMENT_VOICE",
    );
    expect(deploymentVoiceFromEnv(JSON.stringify(privateConfig), true)).toBeDefined();
    expect(() =>
      deploymentVoiceFromEnv(
        JSON.stringify({
          ...privateConfig,
          pricing: {
            ...privateConfig.pricing,
            synthesize: { ...price, model: "model with spaces" },
          },
        }),
        true,
      ),
    ).toThrow("Invalid DEPLOYMENT_VOICE");
  });
  it.each(["baseUrl", "sttBaseUrl"])("rejects an invalid %s before consent", (field) => {
    for (const value of ["not a url", "ftp://speech.example.test"]) {
      expect(() =>
        deploymentVoiceFromEnv(
          JSON.stringify({
            ...config,
            provider: "openai-compatible",
            connection: {
              plaintext: "fake-server-key",
              baseUrl: "https://speech.example.test/v1",
              [field]: value,
            },
          }),
        ),
      ).toThrow("Invalid DEPLOYMENT_VOICE");
    }
  });
  it.each([
    { plaintext: "fake-server-key" },
    {
      plaintext: "fake-server-key",
      baseUrl: "https://speech.example.test/v1",
      sttApiKey: "fake-unused-key",
    },
  ])("rejects incomplete compatible connections before advertising speech", (connection) => {
    expect(() =>
      deploymentVoiceFromEnv(
        JSON.stringify({ ...config, provider: "openai-compatible", connection }),
      ),
    ).toThrow("Invalid DEPLOYMENT_VOICE");
  });
  it("validates a provider's fixed transcription model independently", () => {
    const valid = {
      ...config,
      provider: "xai",
      allowUnmeteredUsage: undefined,
      pricing: {
        synthesize: { ...price, model: "tts" },
        transcribe: { ...price, unit: "seconds", model: "grok-voice-transcribe-2.0" },
      },
    };
    expect(deploymentVoiceFromEnv(JSON.stringify(valid))).toBeDefined();
    expect(() =>
      deploymentVoiceFromEnv(
        JSON.stringify({
          ...valid,
          pricing: {
            ...valid.pricing,
            transcribe: { ...valid.pricing.transcribe, model: "mistyped-model" },
          },
        }),
      ),
    ).toThrow("Invalid DEPLOYMENT_VOICE");
  });
  it.each(["synthesize", "transcribe"] as const)(
    "rejects pricing units that disagree with the adapter's %s usage",
    (operation) => {
      for (const allowUnmeteredUsage of [false, true]) {
        expect(() =>
          deploymentVoiceFromEnv(
            JSON.stringify({
              ...config,
              provider: "xai",
              allowUnmeteredUsage,
              pricing: {
                synthesize: {
                  ...price,
                  model: "tts",
                  unit: operation === "synthesize" ? "seconds" : "characters",
                },
                transcribe: {
                  ...price,
                  model: "grok-voice-transcribe-2.0",
                  unit: operation === "transcribe" ? "characters" : "seconds",
                },
              },
            }),
          ),
        ).toThrow("Invalid DEPLOYMENT_VOICE");
      }
    },
  );
  it("requires explicit acceptance of manual reconciliation for unmetered models", () => {
    const unmetered = {
      ...config,
      provider: "openai-compatible",
      connection: { plaintext: "fake-server-key", baseUrl: "https://speech.example.test/v1" },
      allowUnmeteredUsage: undefined,
    };
    expect(() => deploymentVoiceFromEnv(JSON.stringify(unmetered))).toThrow(
      "Invalid DEPLOYMENT_VOICE",
    );
    expect(
      deploymentVoiceFromEnv(JSON.stringify({ ...unmetered, allowUnmeteredUsage: true })),
    ).toBeDefined();
  });
  it("accepts automatically priced models and rejects unknown models without opt-in", () => {
    const metered = {
      ...config,
      provider: "openai",
      allowUnmeteredUsage: undefined,
      pricing: {
        synthesize: { ...price, model: "tts-1" },
        transcribe: { ...price, model: "whisper-1", unit: "seconds" },
      },
    };
    expect(deploymentVoiceFromEnv(JSON.stringify(metered))).toBeDefined();
    expect(() =>
      deploymentVoiceFromEnv(
        JSON.stringify({
          ...metered,
          pricing: { ...metered.pricing, synthesize: { ...price, model: "unknown-speech" } },
        }),
      ),
    ).toThrow("Invalid DEPLOYMENT_VOICE");
  });
  it("does not advertise or choose included speech without an available grant", async () => {
    for (const allowance of [null, { limitMicros: 10n, usedMicros: 10n }]) {
      const d = deps();
      vi.mocked(d.prisma.speechAllowance.findFirst).mockResolvedValue(allowance as never);
      expect(await effectiveVoiceStatus(d, actor)).toMatchObject({
        ready: false,
        configured: false,
      });
      expect(await loadDefaultVoiceCredential(d, actor)).toBeNull();
    }
  });
  it.each(["synthesize", "transcribe"] as const)(
    "keeps an affordable %s available independently of the other reservation",
    async (operation) => {
      const d = deps();
      d.env!.deploymentVoice!.pricing[operation].maxRequestMicros = 10;
      vi.mocked(d.prisma.speechAllowance.findFirst).mockResolvedValue({
        limitMicros: 100n,
        usedMicros: 50n,
      } as never);
      const status = await effectiveVoiceStatus(d, actor);
      expect(status.ready).toBe(operation === "synthesize");
      expect(status.transcribe).toBe(operation === "transcribe");
      if (operation === "synthesize") {
        expect(await synthesizeVoice(d, actor, { text: "Synthetic speech" })).toMatchObject({
          mimeType: "audio/mpeg",
        });
        await expect(
          transcribeVoice(d, actor, { audio: new Uint8Array([1]), mimeType: "audio/wav" }),
        ).rejects.toBeDefined();
      } else {
        expect(
          await transcribeVoice(d, actor, { audio: new Uint8Array([1]), mimeType: "audio/wav" }),
        ).toMatchObject({ text: expect.any(String) });
        await expect(synthesizeVoice(d, actor, { text: "Synthetic speech" })).rejects.toBeDefined();
      }
    },
  );
  it("uses pricing models when compatible connection model fields are omitted", async () => {
    const configured = deploymentVoiceFromEnv(
      JSON.stringify({
        ...config,
        provider: "openai-compatible",
        connection: { plaintext: "fake-server-key", baseUrl: "https://speech.example.test/v1" },
        pricing: {
          synthesize: { ...price, model: "priced-speech" },
          transcribe: { ...price, model: "priced-transcription", unit: "seconds" },
        },
      }),
    )!;
    const d = deps();
    d.env!.deploymentVoice = configured;
    const loaded = await loadDefaultVoiceCredential(d, actor);
    expect(JSON.parse(loaded!.apiKey)).toMatchObject({
      ttsModel: "priced-speech",
      sttModel: "priced-transcription",
    });
    expect(() =>
      deploymentVoiceFromEnv(
        JSON.stringify({
          ...configured,
          connection: { ...configured.connection, ttsModel: "different-speech" },
        }),
      ),
    ).toThrow("Invalid DEPLOYMENT_VOICE");
  });
  it("makes speech ready without storing user credentials", async () => {
    const d = deps();
    expect(await effectiveVoiceStatus(d, actor)).toMatchObject({ ready: true, configured: true });
    expect(await loadDefaultVoiceCredential(d, actor)).toMatchObject({
      deployment: true,
      cred: { provider: "scripted", voiceId: "test-voice" },
      apiKey: "fake-server-key",
    });
    expect(d.secrets.load).not.toHaveBeenCalled();
  });
  it("respects an empty Space override and explicit connection requests", async () => {
    expect(await loadDefaultVoiceCredential(deps(true), actor)).toBeNull();
    expect(await loadVoiceCredential(deps(), actor, "scripted")).toBeNull();
    expect(await effectiveVoiceStatus(deps(true), actor)).toMatchObject({ ready: false });
  });
  it("does not replace a broken explicit connection or decrypt it for status", async () => {
    const d = deps(false, {
      credential: { id: "saved", provider: "scripted", secretId: "missing" },
      voiceId: "explicit",
      isDefault: true,
    });
    expect(await effectiveVoiceStatus(d, actor)).toMatchObject({ voiceId: "explicit" });
    expect(await loadDefaultVoiceCredential(d, actor)).toBeNull();
    expect(d.secrets.load).not.toHaveBeenCalled();
  });
});

it("returns completed audio when settlement storage fails", async () => {
  const log = vi.spyOn(getLogger(), "error");
  const usage = {
    model: "speech-model",
    unit: "characters" as const,
    units: 12,
  };
  const provider = vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({
    synthesize: async () => ({
      mimeType: "audio/mpeg",
      bytes: new Uint8Array([1]),
      usage,
      providerRequestId: "fake-provider-request",
    }),
  } as never);
  vi.mocked(settleSpeech).mockRejectedValueOnce(new Error("temporary database outage"));
  const clip = await synthesizeVoice(deps(), actor, { text: "Synthetic speech sample" });
  expect(clip.mimeType).toBe("audio/mpeg");
  expect(clip.bytes.length).toBeGreaterThan(0);
  expect(settleSpeech).toHaveBeenCalledWith(
    expect.anything(),
    "speech-call",
    usage,
    "fake-provider-request",
  );
  expect(log).toHaveBeenCalledWith("Operator speech settlement requires reconciliation", {
    speechCostId: "speech-call",
    provider: "scripted",
    operation: "synthesize",
    providerRequestId: "fake-provider-request",
  });
  provider.mockRestore();
  log.mockRestore();
});

describe("automatic included voice-note consent", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["missing", "synthesis-only", "previous-endpoint", "allowed"])(
    "checks the actual recognition recipient before dispatch (%s)",
    async (consent) => {
      const d = deps();
      const connection = {
        plaintext: "fake-server-key",
        baseUrl: "https://speech.example.test/v1",
        sttBaseUrl: "https://recognition.example.test/v1",
      };
      d.env!.deploymentVoice = deploymentVoiceFromEnv(
        JSON.stringify({ ...config, provider: "openai-compatible", connection }),
      )!;
      const recipient = adapters.aiRecipient({
        provider: "openai-compatible",
        use: "voice",
        baseUrl:
          consent === "synthesis-only"
            ? connection.baseUrl
            : consent === "previous-endpoint"
              ? "https://old-recognition.example.test/v1"
              : connection.sttBaseUrl,
      })!;
      const findMany = vi.fn(async () =>
        consent === "missing" ? [] : [{ recipientKey: recipient.key }],
      );
      Object.assign(d.prisma, { aiDataConsent: { findMany } });
      const transcribe = vi.fn(async () => ({ text: "Synthetic transcript" }));
      const create = vi
        .spyOn(adapters, "createVoiceProvider")
        .mockReturnValue({ transcribe } as never);
      vi.mocked(admitSpeech).mockClear();
      const result = await transcribeInboundVoice(d, actor, {
        audio: new Uint8Array([1]),
        mimeType: "audio/ogg",
      });
      expect(result).toBe(consent === "allowed" ? "Synthetic transcript" : null);
      expect(findMany).toHaveBeenCalledWith({
        where: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          version: AI_DISCLOSURE_VERSION,
          recipientKey: {
            in: [
              adapters.aiRecipient({
                provider: "openai-compatible",
                use: "voice",
                baseUrl: connection.sttBaseUrl,
              })!.key,
            ],
          },
        },
        select: { recipientKey: true },
      });
      if (consent === "allowed") {
        expect(transcribe).toHaveBeenCalledOnce();
        expect(admitSpeech).toHaveBeenCalledOnce();
      } else {
        expect(create).not.toHaveBeenCalled();
        expect(transcribe).not.toHaveBeenCalled();
        expect(admitSpeech).not.toHaveBeenCalled();
      }
    },
  );
});

describe("interactive included speech consent", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["synthesize", "transcribe"] as const)(
    "requires consent for the actual %s recipient before admission or dispatch",
    async (operation) => {
      for (const consent of ["missing", "other-operation", "allowed"]) {
        const d = deps();
        const connection = {
          plaintext: "fake-server-key",
          baseUrl: "https://speech.example.test/v1",
          sttBaseUrl: "https://recognition.example.test/v1",
        };
        d.env!.deploymentVoice = deploymentVoiceFromEnv(
          JSON.stringify({ ...config, provider: "openai-compatible", connection }),
        );
        const requestedUrl =
          operation === "synthesize" ? connection.baseUrl : connection.sttBaseUrl;
        const otherUrl = operation === "synthesize" ? connection.sttBaseUrl : connection.baseUrl;
        const recipient = adapters.aiRecipient({
          provider: "openai-compatible",
          use: "voice",
          baseUrl: consent === "other-operation" ? otherUrl : requestedUrl,
        })!;
        const findMany = vi.fn(async () =>
          consent === "missing" ? [] : [{ recipientKey: recipient.key }],
        );
        Object.assign(d.prisma, { aiDataConsent: { findMany } });
        const synthesize = vi.fn(async () => ({
          mimeType: "audio/mpeg",
          bytes: new Uint8Array([1]),
        }));
        const transcribe = vi.fn(async () => ({ text: "Synthetic transcript" }));
        const create = vi
          .spyOn(adapters, "createVoiceProvider")
          .mockReturnValue({ synthesize, transcribe } as never);
        vi.mocked(admitSpeech).mockClear();
        const request =
          operation === "synthesize"
            ? synthesizeVoice(d, actor, { text: "Synthetic speech" })
            : transcribeVoice(d, actor, { audio: new Uint8Array([1]), mimeType: "audio/wav" });
        if (consent === "allowed") {
          await expect(request).resolves.toBeDefined();
          expect(operation === "synthesize" ? synthesize : transcribe).toHaveBeenCalledOnce();
          expect(admitSpeech).toHaveBeenCalledOnce();
        } else {
          await expect(request).rejects.toMatchObject({
            kind: "FORBIDDEN",
            code: "AI_CONSENT_REQUIRED",
          });
          expect(synthesize).not.toHaveBeenCalled();
          expect(transcribe).not.toHaveBeenCalled();
          expect(admitSpeech).not.toHaveBeenCalled();
        }
        expect(findMany).toHaveBeenCalledWith({
          where: {
            userId: actor.userId,
            spaceId: actor.spaceId,
            version: AI_DISCLOSURE_VERSION,
            recipientKey: {
              in: [
                adapters.aiRecipient({
                  provider: "openai-compatible",
                  use: "voice",
                  baseUrl: requestedUrl,
                })!.key,
              ],
            },
          },
          select: { recipientKey: true },
        });
        create.mockRestore();
      }
    },
  );
});
