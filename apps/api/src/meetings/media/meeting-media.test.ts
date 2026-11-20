import type { AgentRunRequest, AgentRuntime, VoiceProvider } from "@rakazo/adapter-kit";
import { ModelAccountError, VoiceAccountError } from "@rakazo/adapter-kit";
import { NoVoiceConfigured, UnavailableModelForAuthError } from "@rakazo/adapters";
import { MEETING_MEDIA_PATH } from "@rakazo/adapters/meeting-media";
import { MISSING_MODEL_RUN_ERROR } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceDeps } from "../../calls/voice.js";
import {
  loadDefaultVoiceCredential,
  resolveVoiceTarget,
  synthesizeVoice,
  transcribeVoice,
  voiceProviderFor,
} from "../../calls/voice.js";
import type { DeploymentVoice } from "../../voice/deployment-config.js";
import { hasDeploymentVoiceConsent } from "../../voice/deployment-consent.js";
import { MEETING_SAMPLE_RATE, meetingAudioWav } from "./meeting-audio.js";
import { createMeetingMedia, meetingVoiceReady } from "./meeting-media.js";
import { meetingTone } from "./meeting-media.test-support.js";

vi.mock("../../calls/voice.js", () => ({
  loadDefaultVoiceCredential: vi.fn(),
  resolveVoiceTarget: vi.fn(),
  transcribeVoice: vi.fn(),
  synthesizeVoice: vi.fn(),
  voiceProviderFor: vi.fn(),
}));
vi.mock("../../voice/deployment-consent.js", () => ({ hasDeploymentVoiceConsent: vi.fn() }));
vi.mock("@rakazo/adapters", () => ({
  NoVoiceConfigured: class extends Error {},
  UnavailableModelForAuthError: class extends Error {},
  isRetiredModelCredentialError: () => false,
}));
vi.mock("@rakazo/db", () => ({
  LeaseHeldError: class extends Error {},
  recordUsage: vi.fn(),
  runAsTenant: (_scope: unknown, work: () => unknown) => work(),
  withLease: (
    _prisma: unknown,
    _name: string,
    { signal }: { signal: AbortSignal },
    work: (lease: { signal: AbortSignal }) => unknown,
  ) => work({ signal }),
}));

const actor = {
  userId: "emulator-user",
  spaceId: "emulator-space",
  email: "meeting@example.test",
  isDeploymentOwner: false,
};

const voiceDeps = {
  prisma: {} as PrismaClient,
  secrets: {} as VoiceDeps["secrets"],
};

function fixture(modelText: string) {
  const run = vi.fn<AgentRuntime["run"]>(async function* () {
    yield { type: "done", text: modelText };
  });
  const runtime: AgentRuntime = {
    run,
    abort: vi.fn(async () => {}),
    describe: () => ({
      id: "fixture-runtime",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: true, tools: false, scripted: false },
    }),
  };
  const resolveModel = vi.fn<() => Promise<AgentRunRequest["model"]>>(async () => ({
    provider: "test-connection",
    id: "fixture-model",
  }));
  const media = createMeetingMedia({
    ...voiceDeps,
    runtime,
    resolveModel,
    signingSecret: "emulator-secret",
    publicOrigin: "https://rakazo.example.test",
    voiceReady: async () => true,
    loadSession: async () => ({
      actor,
      botId: "emulator-bot",
      botName: "Atlas",
      voice: true,
      admitted: true,
    }),
  });
  const app = new Hono();
  media.mount(app);
  const token = new URL(
    media.pageUrl("joined-session", new Date(Date.now() + 30_000), true),
  ).hash.slice(1);
  return {
    run,
    resolveModel,
    token,
    say: (options?: { context?: string; grant?: string }) =>
      app.request(`${MEETING_MEDIA_PATH}/turn`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options?.grant ?? token}`,
          "content-type": "application/octet-stream",
          ...(options?.context ? { "x-meeting-context": options.context } : {}),
        },
        body: meetingTone(MEETING_SAMPLE_RATE / 2),
      }),
  };
}

describe("live meeting voice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(transcribeVoice).mockResolvedValue({ text: "Atlas, when is the demo?" });
    vi.mocked(synthesizeVoice).mockResolvedValue({
      bytes: meetingAudioWav(meetingTone(MEETING_SAMPLE_RATE)),
      mimeType: "audio/wav",
    });
  });

  it("transcribes a turn, uses meeting-only context and voices an addressed reply", async () => {
    const { run, resolveModel, say } = fixture('{"reply":"The demo is Thursday."}');
    const response = await say();
    expect(response.status).toBe(200);
    const participant = response.headers.get("x-meeting-context");
    const spoken = response.headers.get("x-meeting-spoken-context");
    expect(participant).toBeTruthy();
    expect(spoken).toBeTruthy();
    expect(spoken).not.toBe(participant);
    expect(resolveModel).toHaveBeenCalledExactlyOnceWith(actorForRun());
    expect(resolveModel.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(transcribeVoice).mock.invocationCallOrder[0]!,
    );
    expect(transcribeVoice).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ mimeType: "audio/wav", callId: "joined-session" }),
    );
    const [request, context] = run.mock.calls[0]!;
    expect(context).toMatchObject(actorForRun());
    expect(request).toMatchObject({ tools: [], history: [], usageOperationKind: "answer" });
    expect(JSON.parse(request.prompt)).toEqual({
      participantName: "Atlas",
      earlierMeeting: "",
      latestUtterance: "Atlas, when is the demo?",
    });
    expect(synthesizeVoice).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ botId: "emulator-bot", text: "The demo is Thursday." }),
    );
  });

  it("voices a shortened reply when the model exceeds the speech limit", async () => {
    const prefix = "a".repeat(418);
    const { say } = fixture(JSON.stringify({ reply: `${prefix}🌱 and then more.` }));

    expect((await say()).status).toBe(200);
    expect(synthesizeVoice).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      actor,
      expect.objectContaining({ text: `${prefix}…` }),
    );
  });

  it("keeps an unattended participant turn as context across replicas", async () => {
    vi.mocked(transcribeVoice).mockResolvedValueOnce({ text: "The demo moved to Thursday." });
    const earlier = fixture('{"reply":null}');
    const response = await earlier.say();
    expect(response.status).toBe(204);
    const context = response.headers.get("x-meeting-context");
    expect(context).toBeTruthy();
    expect(context).not.toContain("Thursday");

    const next = fixture('{"reply":"Thursday."}');
    expect((await next.say({ context: context!, grant: earlier.token })).status).toBe(200);
    const [request] = next.run.mock.calls[0]!;
    expect(JSON.parse(request.prompt)).toEqual({
      participantName: "Atlas",
      earlierMeeting: "Participant: The demo moved to Thursday.",
      latestUtterance: "Atlas, when is the demo?",
    });
    expect(synthesizeVoice).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      actor,
      expect.objectContaining({ text: "Thursday." }),
    );
  });

  it("accepts a fenced structured response", async () => {
    const { say } = fixture('```json\n{"reply":"Thursday."}\n```');
    expect((await say()).status).toBe(200);
    expect(synthesizeVoice).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      actor,
      expect.objectContaining({ text: "Thursday." }),
    );
  });

  it("skips paid transcription when the model resolver would use a scripted fallback", async () => {
    const { say, run, resolveModel } = fixture('{"reply":"An unexpected reply."}');
    resolveModel.mockResolvedValue({ provider: "scripted", id: "scripted" });
    expect((await say()).status).toBe(204);
    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    new Error(MISSING_MODEL_RUN_ERROR),
    new UnavailableModelForAuthError("The selected connection is unavailable."),
  ])("skips paid transcription when model setup fails (%s)", async (error) => {
    const { say, run, resolveModel } = fixture('{"reply":"An unexpected reply."}');
    resolveModel.mockRejectedValue(error);
    expect((await say()).status).toBe(204);
    expect(transcribeVoice).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: new VoiceAccountError(undefined, "Private voice provider details"),
      kind: "voice_account",
    },
    { error: new ModelAccountError("Private model provider details"), kind: "model_account" },
  ])("reports $kind without recording provider details", async ({ error, kind }) => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    try {
      const { say } = fixture('{"reply":"An unexpected reply."}');
      vi.mocked(transcribeVoice).mockRejectedValueOnce(error);
      expect((await say()).status).toBe(204);
      expect(warn).toHaveBeenCalledExactlyOnceWith("Meeting voice connection refused", {
        "meeting.failure": kind,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['{"reply":null}', "unstructured model text"])(
    "stays silent for %s",
    async (modelText) => {
      const { say } = fixture(modelText);
      expect((await say()).status).toBe(204);
      expect(synthesizeVoice).not.toHaveBeenCalled();
    },
  );
});

describe("meeting microphone readiness", () => {
  const personal = {
    cred: { provider: "fixture-speech" },
    deployment: false,
  };
  const deploymentVoice = {} as DeploymentVoice;
  const deployed = { ...voiceDeps, env: { deploymentVoice } };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveVoiceTarget).mockResolvedValue({
      ...personal,
      voiceId: "bot-override",
    } as Awaited<ReturnType<typeof resolveVoiceTarget>>);
    vi.mocked(loadDefaultVoiceCredential).mockResolvedValue(
      personal as Awaited<ReturnType<typeof loadDefaultVoiceCredential>>,
    );
    vi.mocked(voiceProviderFor).mockResolvedValue({
      transcribe: vi.fn(),
    } as unknown as VoiceProvider);
  });

  it("requires a resolved voice for the meeting bot, including an override", async () => {
    expect(await meetingVoiceReady(voiceDeps, actor, "emulator-bot")).toBe(true);
    expect(resolveVoiceTarget).toHaveBeenCalledWith(
      voiceDeps,
      actor,
      expect.objectContaining({ botId: "emulator-bot" }),
    );
    expect(hasDeploymentVoiceConsent).not.toHaveBeenCalled();

    vi.mocked(resolveVoiceTarget).mockRejectedValue(new NoVoiceConfigured("voice"));
    expect(await meetingVoiceReady(voiceDeps, actor, "emulator-bot")).toBe(false);
  });

  it.each([
    { synthesize: false, transcribe: true },
    { synthesize: true, transcribe: false },
    { synthesize: true, transcribe: true },
  ])(
    "requires deployment consent for $synthesize synthesis and $transcribe transcription",
    async (operations) => {
      vi.mocked(resolveVoiceTarget).mockResolvedValue({
        ...personal,
        deployment: operations.synthesize,
        voiceId: "bot-override",
      } as Awaited<ReturnType<typeof resolveVoiceTarget>>);
      vi.mocked(loadDefaultVoiceCredential).mockResolvedValue({
        ...personal,
        deployment: operations.transcribe,
      } as Awaited<ReturnType<typeof loadDefaultVoiceCredential>>);
      vi.mocked(hasDeploymentVoiceConsent).mockResolvedValue(false);
      expect(await meetingVoiceReady(deployed, actor, "emulator-bot")).toBe(false);
      expect(hasDeploymentVoiceConsent).toHaveBeenCalledExactlyOnceWith(
        voiceDeps.prisma,
        actor,
        deploymentVoice,
        operations,
      );

      vi.mocked(hasDeploymentVoiceConsent).mockResolvedValue(true);
      expect(await meetingVoiceReady(deployed, actor, "emulator-bot")).toBe(true);
    },
  );
});

function actorForRun() {
  return { userId: actor.userId, spaceId: actor.spaceId, botId: "emulator-bot" };
}
