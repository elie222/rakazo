import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { deploymentVoiceFromEnv } from "./deployment-voice.js";
import type { VoiceDeps } from "./voice.js";
import { effectiveVoiceStatus, loadDefaultVoiceCredential, loadVoiceCredential } from "./voice.js";

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
