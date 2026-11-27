import type { AdapterContext } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import { isOwnerStartedRun, toolRequiresApproval } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptedVoiceProvider } from "../providers/voice/scripted/scripted-voice.js";
import { selectBuiltinToolsForRun } from "../runs/tools/run-tool-selection.js";
import { VoiceProviderUnavailableError } from "./voice-http.js";
import {
  hasVoiceForMessages,
  speakVoiceMessage,
  voiceMessageFileName,
  voiceMessageRequestedByOwner,
} from "./voice-message.js";
import type { DefaultVoiceDeps } from "./voice-model-connection.js";

const db = vi.hoisted(() => ({ findDefaultVoiceCredential: vi.fn() }));
const connection = vi.hoisted(() => ({ loadDefaultVoice: vi.fn() }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  findDefaultVoiceCredential: db.findDefaultVoiceCredential,
}));
vi.mock("./voice-model-connection.js", async (original) => ({
  ...(await original<typeof import("./voice-model-connection.js")>()),
  loadDefaultVoice: connection.loadDefaultVoice,
}));

const scope = { userId: "owner", spaceId: "space" };
const context: AdapterContext = {
  ...scope,
  operationId: "op",
  traceId: "trace",
  signal: new AbortController().signal,
};
const secretCount = vi.fn();
const prisma = { secret: { count: secretCount } } as unknown as PrismaClient;
const deps = { prisma, secretStore: {} } as unknown as DefaultVoiceDeps;

function connected(voiceId: string, speechModel = "", linked = false) {
  const provider = new ScriptedVoiceProvider();
  const synthesize = vi.spyOn(provider, "synthesize");
  connection.loadDefaultVoice.mockResolvedValue({
    credential: { provider: "elevenlabs", voiceId, speechModel },
    provider,
    apiKey: "voice-key",
    linked,
  });
  return synthesize;
}

beforeEach(() => {
  db.findDefaultVoiceCredential.mockReset();
  connection.loadDefaultVoice.mockReset();
  secretCount.mockReset().mockResolvedValue(1);
});

describe("voice messages", () => {
  it("speaks in the bot's voice, else the connection's, with the connection's model", async () => {
    const synthesize = connected("account-voice", "fast-model");
    const spoken = await speakVoiceMessage(
      deps,
      scope,
      { text: "Hello", botVoiceId: "bot-voice" },
      context,
    );
    expect(spoken).toMatchObject({ clip: { mimeType: "audio/mpeg" }, provider: "elevenlabs" });
    expect(synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello",
        voiceId: "bot-voice",
        apiKey: "voice-key",
        model: "fast-model",
      }),
      context,
    );
    await speakVoiceMessage(deps, scope, { text: "Hello", botVoiceId: null }, context);
    expect(synthesize).toHaveBeenLastCalledWith(
      expect.objectContaining({ voiceId: "account-voice" }),
      context,
    );
  });

  it("falls back to the connection's voice when the provider refuses the bot's", async () => {
    // The bot's voice was chosen with the earlier provider; the new one does not know it.
    const synthesize = connected("new-provider-voice");
    synthesize.mockImplementation(async (request) => {
      if (request.voiceId === "old-provider-voice") throw new Error("Unknown voice.");
      return { bytes: new Uint8Array([1]), mimeType: "audio/mpeg" };
    });
    const spoken = await speakVoiceMessage(
      deps,
      scope,
      { text: "Hello", botVoiceId: "old-provider-voice" },
      context,
    );
    expect(spoken).toMatchObject({ clip: { mimeType: "audio/mpeg" } });
    expect(synthesize.mock.calls.map(([request]) => request.voiceId)).toEqual([
      "old-provider-voice",
      "new-provider-voice",
    ]);
  });

  it("does not try another voice when the account, an outage or the connection's own voice failed", async () => {
    const synthesize = connected("account-voice");
    synthesize.mockRejectedValue(new VoiceAccountError("VOICE_OUT_OF_CREDIT", "Out of credit."));
    await expect(
      speakVoiceMessage(deps, scope, { text: "Hello", botVoiceId: "bot-voice" }, context),
    ).rejects.toThrow("Out of credit.");
    expect(synthesize).toHaveBeenCalledTimes(1);
    synthesize
      .mockReset()
      .mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(
      speakVoiceMessage(deps, scope, { text: "Hello", botVoiceId: "bot-voice" }, context),
    ).rejects.toBeInstanceOf(VoiceProviderUnavailableError);
    expect(synthesize).toHaveBeenCalledTimes(1);
    synthesize.mockReset().mockRejectedValue(new Error("Unknown voice."));
    await expect(
      speakVoiceMessage(deps, scope, { text: "Hello", botVoiceId: null }, context),
    ).rejects.toThrow("Unknown voice.");
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("names each recording apart, and the same call the same", () => {
    const first = voiceMessageFileName("call-1", "audio/mpeg");
    expect(first).toMatch(/^voice-message-[0-9a-f]{8}\.mp3$/);
    expect(voiceMessageFileName("call-1", "audio/mpeg")).toBe(first);
    expect(voiceMessageFileName("call-2", "audio/mpeg")).not.toBe(first);
    expect(voiceMessageFileName("call-1", "audio/wav")).toMatch(/\.wav$/);
  });

  it("leaves the model to the provider when the connection sets none", async () => {
    const synthesize = connected("account-voice");
    await speakVoiceMessage(deps, scope, { text: "Hello", botVoiceId: null }, context);
    expect(synthesize.mock.calls[0]?.[0].model).toBeUndefined();
  });

  it("says what is missing instead of speaking", async () => {
    connection.loadDefaultVoice.mockResolvedValue(null);
    expect(
      await speakVoiceMessage(deps, scope, { text: "Hello", botVoiceId: "bot-voice" }, context),
    ).toEqual({ missing: "connection" });
    const synthesize = connected("");
    expect(
      await speakVoiceMessage(deps, scope, { text: "Hello", botVoiceId: null }, context),
    ).toEqual({ missing: "voice" });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("explains a Models connection the provider refused, as the app's speech does", async () => {
    const synthesize = connected("account-voice", "", true);
    synthesize.mockRejectedValue(new VoiceAccountError("VOICE_KEY_REJECTED", "Bad key."));
    await expect(
      speakVoiceMessage(deps, scope, { text: "Hello", botVoiceId: null }, context),
    ).rejects.toThrow("Disconnect and paste an API key.");
  });

  it("is available only with a known provider, a voice and the connection's key", async () => {
    db.findDefaultVoiceCredential.mockResolvedValue(null);
    expect(await hasVoiceForMessages(prisma, scope, "bot-voice")).toBe(false);
    db.findDefaultVoiceCredential.mockResolvedValue({
      provider: "elevenlabs",
      voiceId: "",
      secretId: "secret",
    });
    expect(await hasVoiceForMessages(prisma, scope, null)).toBe(false);
    expect(await hasVoiceForMessages(prisma, scope, "bot-voice")).toBe(true);
    expect(secretCount).toHaveBeenCalledWith({
      where: { id: "secret", userId: "owner", spaceId: null },
    });
    secretCount.mockResolvedValue(0);
    expect(await hasVoiceForMessages(prisma, scope, "bot-voice")).toBe(false);
    db.findDefaultVoiceCredential.mockResolvedValue({
      provider: "retired",
      voiceId: "v",
      secretId: "secret",
    });
    secretCount.mockResolvedValue(1);
    expect(await hasVoiceForMessages(prisma, scope, null)).toBe(false);
  });

  it("is requested only by the person's own words", () => {
    const own = { ownerStartedRun: true, messagingChannelRun: false };
    const other = { ownerStartedRun: false, messagingChannelRun: false };
    expect(voiceMessageRequestedByOwner("user", own)).toBe(true);
    expect(voiceMessageRequestedByOwner("messaging", other)).toBe(true);
    expect(
      voiceMessageRequestedByOwner("messaging", {
        ownerStartedRun: false,
        messagingChannelRun: true,
      }),
    ).toBe(false);
    for (const trigger of ["bot_message", "routine", "webhook", "email", "tickets"])
      expect(voiceMessageRequestedByOwner(trigger, other)).toBe(false);
  });

  it("is not requested by hanging up a call", () => {
    // The post-call turn has no new message from the person and writes its reply.
    const ownerStartedRun = isOwnerStartedRun("call_end", false);
    expect(ownerStartedRun).toBe(true);
    expect(
      voiceMessageRequestedByOwner("call_end", { ownerStartedRun, messagingChannelRun: false }),
    ).toBe(false);
  });

  it("is offered to runs that can post, without an approval card", () => {
    expect(toolRequiresApproval("voice_message", false)).toBe(false);
    const base = {
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "message",
      semanticMemoryEnabled: false,
      messagingChannelRun: false,
    };
    const names = (extra = {}) =>
      selectBuiltinToolsForRun({ ...base, ...extra }).map((tool) => tool.name);
    expect(names()).not.toContain("voice_message");
    expect(names({ voiceMessagesEnabled: true })).toContain("voice_message");
    expect(names({ voiceMessagesEnabled: true, trigger: "tickets" })).not.toContain(
      "voice_message",
    );
    expect(names({ voiceMessagesEnabled: true, messagingChannelRun: true })).not.toContain(
      "voice_message",
    );
    expect(
      names({ voiceMessagesEnabled: true, disabledBuiltinTools: ["voice_message"] }),
    ).not.toContain("voice_message");
  });
});
