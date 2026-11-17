import type { AdapterContext } from "@rakazo/adapter-kit";
import { toolRequiresApproval } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptedVoiceProvider } from "./providers/voice/scripted/scripted-voice.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import type { DefaultVoiceDeps } from "./voice-model-connection.js";

const db = vi.hoisted(() => ({ findDefaultVoiceCredential: vi.fn() }));
const connection = vi.hoisted(() => ({ loadDefaultVoice: vi.fn() }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  findDefaultVoiceCredential: db.findDefaultVoiceCredential,
}));
vi.mock("./voice-model-connection.js", () => ({ loadDefaultVoice: connection.loadDefaultVoice }));

const { hasVoiceForMessages, speakVoiceMessage } = await import("./voice-message.js");

const scope = { userId: "owner", spaceId: "space" };
const context: AdapterContext = {
  ...scope,
  operationId: "op",
  traceId: "trace",
  signal: new AbortController().signal,
};
const prisma = {} as PrismaClient;
const deps = { prisma, secretStore: {} } as unknown as DefaultVoiceDeps;

function connected(voiceId: string, speechModel = "") {
  const provider = new ScriptedVoiceProvider();
  const synthesize = vi.spyOn(provider, "synthesize");
  connection.loadDefaultVoice.mockResolvedValue({
    credential: { provider: "elevenlabs", voiceId, speechModel },
    provider,
    apiKey: "voice-key",
  });
  return synthesize;
}

beforeEach(() => {
  db.findDefaultVoiceCredential.mockReset();
  connection.loadDefaultVoice.mockReset();
});

describe("voice messages", () => {
  it("speaks in the bot's voice, else the connection's, with the connection's model", async () => {
    const synthesize = connected("account-voice", "fast-model");
    const clip = await speakVoiceMessage(
      deps,
      scope,
      { text: "Hello", botVoiceId: "bot-voice" },
      context,
    );
    expect(clip?.mimeType).toBe("audio/mpeg");
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
      expect.objectContaining({ voiceId: "account-voice", model: undefined }),
      context,
    );
  });

  it("speaks nothing without a connection or a chosen voice", async () => {
    connection.loadDefaultVoice.mockResolvedValue(null);
    expect(
      await speakVoiceMessage(deps, scope, { text: "Hello", botVoiceId: "bot-voice" }, context),
    ).toBeNull();
    const synthesize = connected("");
    expect(
      await speakVoiceMessage(deps, scope, { text: "Hello", botVoiceId: null }, context),
    ).toBeNull();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("is available only with a known provider and a voice", async () => {
    db.findDefaultVoiceCredential.mockResolvedValue(null);
    expect(await hasVoiceForMessages(prisma, scope, "bot-voice")).toBe(false);
    db.findDefaultVoiceCredential.mockResolvedValue({ provider: "elevenlabs", voiceId: "" });
    expect(await hasVoiceForMessages(prisma, scope, null)).toBe(false);
    expect(await hasVoiceForMessages(prisma, scope, "bot-voice")).toBe(true);
    db.findDefaultVoiceCredential.mockResolvedValue({ provider: "retired", voiceId: "v" });
    expect(await hasVoiceForMessages(prisma, scope, null)).toBe(false);
  });

  it("is offered to the person's own runs that can post, without an approval card", () => {
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
