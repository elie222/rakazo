import { AiConsentBlocked, callIdFromClientNonce } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallClip, CallDeps, CallEnded, DictationHandlers } from "./call-session";
import {
  endCall,
  getSnapshot,
  INTERIM_BARGE_IN_MS,
  setCallProviderTranscribe,
  startCall,
  subscribe,
  toggleMute,
} from "./call-session";

vi.mock("expo-file-system", () => ({ File: class {}, Paths: {} }));
vi.mock("./voice", () => ({ speakText: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock("./api", () => ({
  applyMobileThreadEvent: vi.fn(),
  blockText: vi.fn(),
  captureApiRequestContext: vi.fn(),
  rpc: vi.fn(),
  subscribeThread: vi.fn(),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakes(opts: { onDevice?: boolean } = {}) {
  const recordings: Array<Deferred<CallClip | null>> = [];
  const signals: AbortSignal[] = [];
  const speeches: Array<Deferred<void>> = [];
  const send = vi.fn(
    async (_botId: string, _text: string, _clientNonce: string): Promise<string | undefined> =>
      "run-1",
  );
  const closeCall = vi.fn(async (_botId: string, _callId: string) => undefined);
  const unwatch = vi.fn();
  let reply: (messageId: string, text: string, runId?: string) => void = () => undefined;
  let ended: (ended: CallEnded) => void = () => undefined;
  const spoken: string[] = [];
  let handlers: DictationHandlers | null = null;
  const stopSpeaking = vi.fn(() => {
    speeches[speeches.length - 1]?.resolve();
  });
  const deps: CallDeps = {
    dictate: async (next, signal) => {
      signals.push(signal);
      if (!opts.onDevice) return false;
      handlers = next;
      return true;
    },
    stopSpeaking,
    record: (signal) => {
      signals.push(signal);
      const next = deferred<CallClip | null>();
      recordings.push(next);
      return next.promise;
    },
    // The fake clip carries the words, so transcription is the identity.
    transcribe: async (clip) => clip.base64,
    send,
    endCall: closeCall,
    speak: (_botId, text) => {
      spoken.push(text);
      const next = deferred<void>();
      speeches.push(next);
      return next.promise;
    },
    watch: (_botId, onReply, onCallEnded) => {
      reply = onReply;
      ended = onCallEnded;
      return unwatch;
    },
  };
  return {
    deps,
    stopSpeaking,
    interim: (text: string) => handlers?.onInterim(text),
    hear: (text: string) => handlers?.onFinal(text),
    recordings,
    signals,
    speeches,
    spoken,
    send,
    closeCall,
    unwatch,
    say: (text: string) =>
      recordings[recordings.length - 1]?.resolve({ base64: text, mimeType: "audio/m4a" }),
    replyWith: (messageId: string, text: string, runId?: string) => reply(messageId, text, runId),
    endedCall: (callId: string | undefined, farewell?: string) => ended({ callId, farewell }),
  };
}

afterEach(() => endCall());

describe("mobile call session", () => {
  it("starts listening for the bot on the call", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    expect(getSnapshot()).toMatchObject({ botId: "bot-1", botName: "Ada", phase: "listening" });
    expect(fake.recordings).toHaveLength(1);
  });

  it("sends what it heard to the call's bot", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("how is the deploy going");
    await flush();
    expect(fake.send).toHaveBeenCalledWith(
      "bot-1",
      "how is the deploy going",
      expect.stringMatching(/^call:/),
    );
    expect(getSnapshot()).toMatchObject({ phase: "thinking", heard: "how is the deploy going" });
  });

  it("mutes after a consent refusal instead of reopening the microphone or resending", async () => {
    const fake = fakes({ onDevice: true });
    fake.send.mockRejectedValueOnce(new AiConsentBlocked("consent denied"));
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await flush();

    fake.hear("status please");
    await flush();

    expect(fake.send).toHaveBeenCalledOnce();
    expect(fake.signals).toHaveLength(1);
    expect(fake.recordings).toHaveLength(0);
    expect(getSnapshot()).toMatchObject({
      phase: "listening",
      muted: true,
      caption: "consent denied",
    });
  });

  it("tags every message in one call with the same call id", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("how is the deploy going");
    await flush();
    fake.replyWith("message-1", "It is green.");
    fake.speeches[0]?.resolve();
    await flush();
    fake.say("and the tests");
    await flush();

    const nonces = fake.send.mock.calls.map((call) => call[2]);
    expect(nonces).toHaveLength(2);
    expect(callIdFromClientNonce(nonces[0])).toBe(callIdFromClientNonce(nonces[1]));
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("speaks a reply, then listens again", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("status please");
    await flush();
    fake.replyWith("message-1", "It is green.");
    expect(getSnapshot()?.phase).toBe("speaking");
    expect(getSnapshot()?.exchanges).toEqual([
      { role: "user", text: "status please" },
      { role: "bot", text: "It is green." },
    ]);
    fake.speeches[0]?.resolve();
    await flush();
    expect(getSnapshot()?.phase).toBe("listening");
    expect(fake.recordings).toHaveLength(2);
  });

  it("mutes after a speech-provider consent refusal without recording another turn", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("status please");
    await flush();
    fake.replyWith("message-1", "It is green.");
    fake.speeches[0]?.reject(new AiConsentBlocked("voice consent denied"));
    await flush();

    expect(fake.recordings).toHaveLength(1);
    expect(getSnapshot()).toMatchObject({
      phase: "listening",
      muted: true,
      caption: "voice consent denied",
    });
  });

  it("keeps retrying ordinary speech errors", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("status please");
    await flush();
    fake.replyWith("message-1", "It is green.");
    fake.speeches[0]?.reject(new Error("voice offline"));
    await flush();

    expect(fake.recordings).toHaveLength(2);
    expect(getSnapshot()).toMatchObject({ phase: "listening", muted: false });
  });

  it("stops recording while muted", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    toggleMute();
    await flush();
    expect(fake.signals[0]?.aborted).toBe(true);
    expect(getSnapshot()).toMatchObject({ muted: true, phase: "listening" });
    expect(fake.recordings).toHaveLength(1);
  });

  it("hangs up once the bot has answered a goodbye", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("that's all, bye");
    await flush();
    expect(fake.send).toHaveBeenCalledWith(
      "bot-1",
      "that's all, bye",
      expect.stringMatching(/^call:/),
    );
    fake.replyWith("message-1", "Talk soon.");
    expect(getSnapshot()?.phase).toBe("speaking");
    fake.speeches[0]?.resolve();
    await flush();
    expect(getSnapshot()).toBeNull();
    expect(fake.unwatch).toHaveBeenCalled();
  });

  it("speaks the farewell and hangs up when the bot ends the call itself", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("end the call and make me a list");
    await flush();
    fake.endedCall(callIdFromClientNonce(fake.send.mock.calls[0]?.[2]), "Talk soon.");
    expect(getSnapshot()?.phase).toBe("speaking");
    expect(fake.spoken).toEqual(["Talk soon."]);
    fake.speeches[0]?.resolve();
    await flush();

    expect(getSnapshot()).toBeNull();
  });

  it("never speaks the work the bot files after it hung up", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("end the call and make me a list");
    await flush();
    fake.endedCall(callIdFromClientNonce(fake.send.mock.calls[0]?.[2]), "Talk soon.");
    fake.replyWith("message-1", "Here is the list.");

    expect(fake.spoken).toEqual(["Talk soon."]);
  });

  it("ignores a call ended event from another call", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("status please");
    await flush();
    fake.endedCall("someone-elses-call", "Talk soon.");
    fake.replyWith("message-1", "It is green.");
    fake.speeches[0]?.resolve();
    await flush();

    expect(getSnapshot()?.phase).toBe("listening");
  });

  it("reports a failed recording and retries, then hangs up cleanly", async () => {
    const fake = fakes();
    let attempts = 0;
    startCall(
      { botId: "bot-1", botName: "Ada" },
      {
        ...fake.deps,
        record: (signal) => {
          attempts += 1;
          return attempts === 1 ? Promise.reject(new Error("mic busy")) : fake.deps.record(signal);
        },
      },
    );
    const captions: string[] = [];
    const stop = subscribe(() => {
      const caption = getSnapshot()?.caption;
      if (caption) captions.push(caption);
    });
    await flush();
    stop();
    expect(captions).toContain("mic busy");
    expect(getSnapshot()?.phase).toBe("listening");
    expect(attempts).toBe(2);
    endCall();
    expect(getSnapshot()).toBeNull();
  });

  it("aborts the bot feed on hang up", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    endCall();
    expect(fake.unwatch).toHaveBeenCalledTimes(1);
    expect(getSnapshot()).toBeNull();
  });

  it("closes the call server-side when the caller presses hang up", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("status please");
    await flush();
    const callId = callIdFromClientNonce(fake.send.mock.calls[0]?.[2]);

    endCall();

    expect(fake.closeCall).toHaveBeenCalledWith("bot-1", callId);
  });

  it("drops a run id that lands after the same bot was called again", async () => {
    const fake = fakes();
    const pending = deferred<string | undefined>();
    fake.send.mockReturnValueOnce(pending.promise);
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("status please");
    await flush();

    endCall();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    pending.resolve("run-1");
    await flush();

    // The new call registered no run of its own, so nothing is filtered against the old one.
    fake.replyWith("message-1", "All good.", "run-2");
    expect(fake.spoken).toEqual(["All good."]);
  });

  it("closes the call server-side once when the caller says goodbye", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("that's all, bye");
    await flush();
    const callId = callIdFromClientNonce(fake.send.mock.calls[0]?.[2]);
    fake.replyWith("message-1", "Talk soon.");
    fake.speeches[0]?.resolve();
    await flush();

    expect(getSnapshot()).toBeNull();
    expect(fake.closeCall).toHaveBeenCalledTimes(1);
    expect(fake.closeCall).toHaveBeenCalledWith("bot-1", callId);
  });

  it("does not close the call again when the bot ended it", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("end the call and make me a list");
    await flush();
    fake.endedCall(callIdFromClientNonce(fake.send.mock.calls[0]?.[2]), "Talk soon.");
    fake.speeches[0]?.resolve();
    await flush();

    expect(getSnapshot()).toBeNull();
    expect(fake.closeCall).not.toHaveBeenCalled();
  });

  it("drops the reply leaking back into the microphone", async () => {
    const fake = fakes({ onDevice: true });
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await flush();
    fake.hear("how is the deploy going");
    await flush();
    fake.replyWith("message-1", "The deploy is green and the tests pass.");
    await flush();

    fake.hear("the deploy is green and the tests pass");
    await flush();

    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(getSnapshot()?.exchanges).toEqual([
      { role: "user", text: "how is the deploy going" },
      { role: "bot", text: "The deploy is green and the tests pass." },
    ]);
  });

  it("leaves a reply from another run out of the call", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("status please");
    await flush();

    // A message typed into the thread mid-call is answered on its own run.
    fake.replyWith("message-typed", "Here is that list.", "run-typed");
    expect(fake.spoken).toEqual([]);
    expect(getSnapshot()).toMatchObject({ phase: "thinking" });

    fake.replyWith("message-1", "It is green.", "run-1");
    expect(fake.spoken).toEqual(["It is green."]);
    expect(getSnapshot()?.exchanges).toEqual([
      { role: "user", text: "status please" },
      { role: "bot", text: "It is green." },
    ]);
  });

  it("does not enable provider transcription when no call is active", async () => {
    setCallProviderTranscribe(true);
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await flush();
    expect(fake.recordings).toHaveLength(0);
  });

  it("uses provider transcription after it is enabled during an active call", async () => {
    const gate = deferred<void>();
    const fake = fakes();
    const startedCallId = startCall(
      { botId: "bot-1", botName: "Ada", transcribe: false },
      {
        ...fake.deps,
        dictate: async () => {
          await gate.promise;
          return false;
        },
      },
    );
    await flush();
    expect(fake.recordings).toHaveLength(0);

    setCallProviderTranscribe(true, startedCallId);
    gate.resolve();
    await flush();
    expect(fake.recordings).toHaveLength(1);
  });

  it("ignores a transcribe probe for another call and resumes listening for this one", async () => {
    const fake = fakes();
    const startedCallId = startCall(
      { botId: "bot-1", botName: "Ada", transcribe: false },
      fake.deps,
    );
    await flush();
    expect(fake.recordings).toHaveLength(0);

    setCallProviderTranscribe(true, "other-call");
    // Unmute listens again, so a probe that flipped this call would record.
    toggleMute();
    toggleMute();
    await flush();
    expect(fake.recordings).toHaveLength(0);

    setCallProviderTranscribe(true, startedCallId);
    await flush();
    expect(fake.recordings).toHaveLength(1);
  });

  it("does not apply a finished probe to a later speak-only call", async () => {
    const fake = fakes();
    const firstCallId = startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await flush();
    const secondCallId = startCall(
      { botId: "bot-1", botName: "Ada", transcribe: false },
      fake.deps,
    );
    await flush();
    expect(secondCallId).not.toBe(firstCallId);
    expect(fake.recordings).toHaveLength(0);

    setCallProviderTranscribe(true, firstCallId);
    // Unmute listens again, so a probe that flipped this call would record.
    toggleMute();
    toggleMute();
    await flush();
    expect(fake.recordings).toHaveLength(0);

    setCallProviderTranscribe(true, secondCallId);
    await flush();
    expect(fake.recordings).toHaveLength(1);
  });

  it("speaks each reply once", async () => {
    const fake = fakes({ onDevice: true });
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await flush();
    fake.hear("status please");
    await flush();
    fake.replyWith("message-1", "It is green.");
    fake.replyWith("message-1", "It is green.");

    expect(fake.spoken).toEqual(["It is green."]);
  });

  it("does not let a stale speech refusal mute a newer call", async () => {
    const fake = fakes({ onDevice: true });
    const firstCallId = startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await flush();
    fake.hear("status please");
    await flush();
    fake.replyWith("message-1", "It is green.");

    const secondCallId = startCall(
      { botId: "bot-1", botName: "Ada", transcribe: false },
      fake.deps,
    );
    await flush();
    fake.speeches[0]?.reject(new AiConsentBlocked("stale consent denied"));
    await flush();

    expect(secondCallId).not.toBe(firstCallId);
    expect(getSnapshot()).toMatchObject({ botId: "bot-1", muted: false });
  });
});

describe("mobile call session on a timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    endCall();
    vi.useRealTimers();
  });

  const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

  it("cuts the reply short when the caller talks over it, and still sends that turn", async () => {
    const fake = fakes({ onDevice: true });
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await tick();
    fake.hear("status please");
    await tick();
    fake.replyWith("message-1", "It is green.");
    await tick();

    fake.interim("actually hang on");
    await tick(INTERIM_BARGE_IN_MS - 1);
    expect(fake.stopSpeaking).not.toHaveBeenCalled();
    await tick(1);
    expect(fake.stopSpeaking).toHaveBeenCalled();
    expect(getSnapshot()?.phase).toBe("listening");

    fake.hear("actually hang on");
    await tick();
    expect(fake.send).toHaveBeenLastCalledWith(
      "bot-1",
      "actually hang on",
      expect.stringMatching(/^call:/),
    );
  });

  it("retries the first snapshot load instead of losing the feed", async () => {
    const { rpc, subscribeThread } = await import("./api");
    vi.mocked(rpc)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ cursor: 3, messages: [], run: null } as never);
    vi.mocked(subscribeThread).mockResolvedValue(undefined as never);
    const fake = fakes();
    const { watch: _watch, ...deps } = fake.deps;
    startCall({ botId: "bot-1", botName: "Ada" }, deps);
    await tick();
    expect(subscribeThread).not.toHaveBeenCalled();

    await tick(500);
    expect(subscribeThread).toHaveBeenCalled();
    expect(vi.mocked(subscribeThread).mock.calls[0]?.[1]).toBe(3);
    vi.mocked(rpc).mockReset();
    vi.mocked(subscribeThread).mockReset();
  });

  it("does not hang up after a farewell whose send was blocked by consent", async () => {
    const fake = fakes({ onDevice: true });
    fake.send.mockRejectedValueOnce(new AiConsentBlocked("consent denied"));
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await tick();

    fake.hear("goodbye");
    await tick();
    expect(getSnapshot()).toMatchObject({
      phase: "listening",
      muted: true,
      caption: "consent denied",
    });

    await tick(20_000);
    expect(fake.closeCall).not.toHaveBeenCalled();
    expect(getSnapshot()?.botId).toBe("bot-1");

    toggleMute();
    await tick();
    expect(fake.closeCall).not.toHaveBeenCalled();
    expect(getSnapshot()).toMatchObject({ botId: "bot-1", muted: false, phase: "listening" });
  });

  it("still ends a bot-ended call when farewell speech consent is refused", async () => {
    const fake = fakes({ onDevice: true });
    const id = startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await tick();
    fake.endedCall(id, "Talk soon.");
    await tick();
    fake.speeches[0]?.reject(new AiConsentBlocked("voice consent denied"));
    await tick();

    expect(getSnapshot()).toBeNull();
    // Bot already closed server-side; local endCall must not re-hit threads/endCall.
    expect(fake.closeCall).not.toHaveBeenCalled();
  });

  it("ends immediately when speech consent is refused after a goodbye already sent", async () => {
    const fake = fakes({ onDevice: true });
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await tick();
    fake.hear("goodbye");
    await tick();
    fake.replyWith("message-1", "Talk soon.");
    await tick();
    fake.speeches[0]?.reject(new AiConsentBlocked("voice consent denied"));
    await tick();

    expect(getSnapshot()).toBeNull();
    expect(fake.closeCall).toHaveBeenCalledOnce();
  });

  it("does not start speech again after consent refuse until the caller unmutes", async () => {
    const fake = fakes({ onDevice: true });
    fake.send.mockRejectedValueOnce(new AiConsentBlocked("consent denied"));
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await tick();
    fake.hear("status please");
    await tick();
    expect(getSnapshot()).toMatchObject({ muted: true });

    fake.replyWith("message-1", "It is green.");
    await tick();
    expect(fake.spoken).toEqual([]);
    expect(getSnapshot()).toMatchObject({ muted: true, botId: "bot-1" });
  });

  it("does not let an earlier farewell timer end the next call", async () => {
    const fake = fakes({ onDevice: true });
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await tick();
    fake.hear("that's all");
    await tick();
    fake.replyWith("message-1", "Talk soon.");
    await tick();

    fake.hear("see you");
    await tick();
    endCall();
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await tick();
    await tick(20_000);

    expect(getSnapshot()?.botId).toBe("bot-1");
  });

  it("reconnects the call feed when the live stream ends", async () => {
    const { rpc, subscribeThread } = await import("./api");
    vi.mocked(rpc).mockResolvedValue({ cursor: 7, messages: [], run: null } as never);
    vi.mocked(subscribeThread).mockResolvedValue(undefined as never);
    const fake = fakes();
    const { watch: _watch, ...deps } = fake.deps;
    startCall({ botId: "bot-1", botName: "Ada" }, deps);
    await tick();
    expect(subscribeThread).toHaveBeenCalledTimes(1);

    await tick(250);
    expect(subscribeThread).toHaveBeenCalledTimes(2);
    expect(vi.mocked(subscribeThread).mock.calls[1]?.[1]).toBe(7);
    vi.mocked(rpc).mockReset();
    vi.mocked(subscribeThread).mockReset();
  });
});
