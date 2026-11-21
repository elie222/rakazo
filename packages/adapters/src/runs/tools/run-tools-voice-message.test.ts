import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileTools } from "./run-tools-files.js";

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  speak: vi.fn(),
}));
vi.mock("../../storage/thread-artifacts.js", async (original) => ({
  ...(await original<typeof import("../../storage/thread-artifacts.js")>()),
  attachWorkspaceFileToThread: mocks.attach,
}));
vi.mock("../../voice/voice-message.js", async (original) => ({
  ...(await original<typeof import("../../voice/voice-message.js")>()),
  speakVoiceMessage: mocks.speak,
}));

const ctx = {
  deps: { artifacts: {}, prisma: {}, events: { notify: vi.fn() } },
  run: { id: "run-1", trigger: "user", userId: "user-1", spaceId: "space-1", threadId: "thread-1" },
  bot: { id: "bot-1", voiceId: null },
  thread: { id: "thread-1", groupId: null },
  source: { ownerStartedRun: true, messagingChannelRun: false },
  context: { signal: new AbortController().signal },
};

function speak(executionId: string, effectId?: string) {
  return fileTools.voice_message!(
    ctx as never,
    {
      name: "voice_message",
      args: { text: "Hello" },
      executionId,
      applied: effectId ? { effect: { id: effectId } } : undefined,
      finish: async (result: unknown) => result,
    } as never,
  );
}

beforeEach(() => {
  mocks.speak.mockReset().mockResolvedValue({
    clip: { bytes: new Uint8Array([1]), mimeType: "audio/mpeg" },
    provider: "scripted",
  });
  let saved = 0;
  mocks.attach.mockReset().mockImplementation(async () => ({ artifactId: `artifact-${++saved}` }));
});

describe("voice_message", () => {
  it("saves each recording as its own file, not a new version of the last", async () => {
    await expect(speak("call-1", "effect-1")).resolves.toEqual({
      ok: true,
      artifactId: "artifact-1",
    });
    await speak("call-2", "effect-2");
    // The artifact family is the file name, so two names are two separate files.
    const names = mocks.attach.mock.calls.map(([, input]) => input.filePath);
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^voice-message-[0-9a-f]+\.mp3$/);
    expect(names[1]).not.toBe(names[0]);
  });

  it("keeps the name when an attempt of the same call is retried", async () => {
    await speak("call-1", "effect-1");
    await speak("call-1-retry", "effect-1");
    const [first, second] = mocks.attach.mock.calls.map(([, input]) => input.filePath);
    expect(second).toBe(first);
  });
});
