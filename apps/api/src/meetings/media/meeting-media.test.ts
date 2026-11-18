import type { AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { MEETING_MEDIA_PATH } from "@rakazo/adapters/meeting-media";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceDeps } from "../../calls/voice.js";
import { synthesizeVoice, transcribeVoice } from "../../calls/voice.js";
import { MEETING_SAMPLE_RATE, meetingAudioWav } from "./meeting-audio.js";
import { createMeetingMedia } from "./meeting-media.js";
import { meetingTone } from "./meeting-media.test-support.js";

vi.mock("../../calls/voice.js", () => ({
  transcribeVoice: vi.fn(),
  synthesizeVoice: vi.fn(),
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

function fixture(modelText: string, recentTranscript?: string) {
  const run = vi.fn<AgentRuntime["run"]>(async function* () {
    yield { type: "done", text: modelText } as AgentRuntimeEvent;
  });
  const runtime = { run } as unknown as AgentRuntime;
  const media = createMeetingMedia({
    prisma: {} as PrismaClient,
    secrets: {} as VoiceDeps["secrets"],
    runtime,
    resolveModel: async () => ({ provider: "test-connection", id: "fixture-model" }),
    signingSecret: "emulator-secret",
    publicOrigin: "https://rakazo.example.test",
    loadSession: async () => ({
      actor,
      botId: "emulator-bot",
      botName: "Atlas",
      voice: true,
      admitted: true,
      recentTranscript,
    }),
  });
  const app = new Hono();
  media.mount(app);
  const token = new URL(media.pageUrl("joined-session", new Date(Date.now() + 30_000))).hash.slice(
    1,
  );
  return {
    run,
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
    const { run, say } = fixture(
      '{"reply":"The demo is Thursday."}',
      "Taylor: The demo is Thursday.",
    );
    expect((await say()).status).toBe(200);
    expect(transcribeVoice).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ mimeType: "audio/wav", callId: "joined-session" }),
    );
    const [request, context] = run.mock.calls[0]!;
    expect(context).toMatchObject(actorForRun());
    expect(request).toMatchObject({ tools: [], history: [] });
    expect(JSON.parse(request.prompt)).toEqual({
      participantName: "Atlas",
      earlierMeeting: "Taylor: The demo is Thursday.",
      latestUtterance: "Atlas, when is the demo?",
    });
    expect(synthesizeVoice).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.objectContaining({ botId: "emulator-bot", text: "The demo is Thursday." }),
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

  it.each(['{"reply":null}', "unstructured model text"])(
    "stays silent for %s",
    async (modelText) => {
      const { say } = fixture(modelText);
      expect((await say()).status).toBe(204);
      expect(synthesizeVoice).not.toHaveBeenCalled();
    },
  );
});

function actorForRun() {
  return { userId: actor.userId, spaceId: actor.spaceId, botId: "emulator-bot" };
}
