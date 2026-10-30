import { AiConsentBlocked, callIdFromClientNonce, INTERIM_BARGE_IN_MS } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallClip, CallDeps, CallEnded, DictationHandlers } from "./call-session";
import {
  ExpectedTurnFailure,
  endCall,
  getSnapshot,
  setCallProviderTranscribe,
  startCall,
  subscribe,
  toggleMute,
} from "./call-session";
import type { SpeechRecognizer } from "./dictation";
import { ENDPOINT_SILENCE_MS, setSpeechRecognizer, stop as stopDictation } from "./dictation";
import { activateUiLocale, getActiveUiLocale } from "./i18n";
import { reportMobileError } from "./monitoring";
import type { UiLocale } from "./ui-locale";

const device = vi.hoisted(() => ({ languageTag: "en-US", os: "ios" }));

vi.mock("./monitoring", () => ({ reportMobileError: vi.fn() }));
vi.mock("expo-localization", () => ({ getLocales: () => [{ languageTag: device.languageTag }] }));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return device.os;
    },
  },
}));
vi.mock("expo-file-system", () => ({ File: class {}, Paths: {} }));
vi.mock("./voice", () => ({
  createSpeechOwner: () => Symbol("SpeechOwner"),
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
}));
vi.mock("./call-sounds", () => ({ playCallCue: vi.fn() }));
// The production recorder, with each step it awaits held by the test.
const audio = vi.hoisted(() => ({
  permission: Promise.resolve({ granted: true }),
  prepared: Promise.resolve(),
  record: vi.fn(),
  release: vi.fn(),
  setAudioMode: vi.fn(),
}));
const expoAudioMock = vi.hoisted(() => () => ({
  AudioModule: {
    requestRecordingPermissionsAsync: () => audio.permission,
    AudioRecorder: class {
      uri = null;
      prepareToRecordAsync = () => audio.prepared;
      record = audio.record;
      stop = async () => undefined;
      release = audio.release;
      getStatus = () => ({});
    },
  },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: async (mode: unknown) => audio.setAudioMode(mode),
}));
vi.mock("expo-audio", () => expoAudioMock());
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
  const cues: string[] = [];
  const waits: string[] = [];
  const deps: CallDeps = {
    cue: async (cue) => {
      cues.push(cue);
    },
    waitSound: (action) => {
      waits.push(action);
    },
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
    cues,
    waits,
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

  it("reports a failed turn unless the caption already explains it", async () => {
    vi.mocked(reportMobileError).mockClear();
    const fake = fakes();
    const unexpected = new Error("send crashed");
    fake.send.mockRejectedValueOnce(unexpected);
    fake.deps.transcribe = vi
      .fn<CallDeps["transcribe"]>()
      .mockRejectedValueOnce(new ExpectedTurnFailure("Could not transcribe that."))
      .mockImplementation(async (clip) => clip.base64);
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("hello");
    await flush();
    expect(fake.deps.transcribe).toHaveBeenCalledTimes(1);
    expect(reportMobileError).not.toHaveBeenCalled();

    fake.say("hello again");
    await flush();
    expect(reportMobileError).toHaveBeenCalledWith(unexpected, "voice.turn");
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

  it("plays the opening cue, speaks the greeting, then listens", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada", greeting: "Hello Riley, Ada here." }, fake.deps);
    await flush();
    expect(fake.cues).toEqual(["start"]);
    expect(fake.spoken).toEqual(["Hello Riley, Ada here."]);
    expect(getSnapshot()?.phase).toBe("speaking");
    expect(fake.recordings).toHaveLength(0);

    fake.speeches[0]?.resolve();
    await flush();
    expect(getSnapshot()?.phase).toBe("listening");
    expect(fake.recordings).toHaveLength(1);
  });

  it("says it is switching, hangs up, then rings the bot the caller asked for", async () => {
    const fake = fakes();
    const ring = vi.fn();
    const switchBot = vi.fn((text: string) =>
      text === "switch to Max" ? { name: "Max", ring } : undefined,
    );
    startCall({ botId: "bot-1", botName: "Ada", switchBot }, fake.deps);
    await flush();
    fake.say("switch to Max");
    await flush();
    expect(switchBot).toHaveBeenCalledWith("switch to Max");
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.cues).toEqual(["start", "end"]);
    expect(fake.spoken).toEqual(["OK, switching to Max."]);
    expect(ring).not.toHaveBeenCalled();

    fake.speeches[0]?.resolve();
    await flush();
    expect(ring).toHaveBeenCalledOnce();
    expect(getSnapshot()).toBeNull();
  });

  it("ignores replies throughout the hand-over cue and speech", async () => {
    const endCue = deferred<void>();
    const fake = fakes();
    const ring = vi.fn();
    startCall(
      { botId: "bot-1", botName: "Ada", switchBot: () => ({ name: "Max", ring }) },
      {
        ...fake.deps,
        cue: (cue) => (cue === "end" ? endCue.promise : Promise.resolve()),
      },
    );
    await flush();
    fake.say("switch to Max");
    await flush();
    fake.replyWith("late-1", "An earlier reply.");
    expect(fake.spoken).toEqual([]);
    endCue.resolve();
    await flush();
    fake.replyWith("late-2", "Another earlier reply.");
    expect(fake.spoken).toEqual(["OK, switching to Max."]);
    expect(fake.recordings).toHaveLength(1);
    fake.speeches[0]?.resolve();
    await flush();
    expect(ring).toHaveBeenCalledOnce();
    expect(getSnapshot()).toBeNull();

    startCall({ botId: "bot-2", botName: "Max" }, fake.deps);
    await flush();
    fake.replyWith("new-1", "Hello from Max.");
    expect(fake.spoken.at(-1)).toBe("Hello from Max.");
  });

  it.each([undefined, "Talk soon."])(
    "ignores an old bot's end event throughout hand-over with farewell %j",
    async (farewell) => {
      const endCue = deferred<void>();
      const fake = fakes();
      const ring = vi.fn();
      const id = startCall(
        { botId: "bot-1", botName: "Ada", switchBot: () => ({ name: "Max", ring }) },
        { ...fake.deps, cue: (cue) => (cue === "end" ? endCue.promise : Promise.resolve()) },
      );
      await flush();
      fake.say("switch to Max");
      await flush();
      fake.endedCall(id, farewell);
      expect(getSnapshot()?.phase).toBe("speaking");
      expect(fake.spoken).toEqual([]);
      endCue.resolve();
      await flush();
      fake.endedCall(id, farewell);
      expect(fake.spoken).toEqual(["OK, switching to Max."]);
      expect(getSnapshot()?.phase).toBe("speaking");
      fake.speeches[0]?.resolve();
      await flush();
      expect(ring).toHaveBeenCalledOnce();
      expect(fake.closeCall).toHaveBeenCalledWith("bot-1", id);
      expect(getSnapshot()).toBeNull();
    },
  );

  it("plays the waiting sound after the closing cue, until the reply starts", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    expect(fake.waits).toEqual(["preload"]);
    fake.say("status please");
    await flush();
    expect(fake.waits).toEqual(["preload", "start"]);
    fake.replyWith("message-1", "It is green.");
    expect(fake.waits).toEqual(["preload", "start", "stop"]);
    endCall();
    expect(fake.waits).toEqual(["preload", "start", "stop", "release"]);
  });

  it("does not ring the other bot when the caller hangs up during the hand-over", async () => {
    const fake = fakes();
    const ring = vi.fn();
    startCall(
      { botId: "bot-1", botName: "Ada", switchBot: () => ({ name: "Max", ring }) },
      fake.deps,
    );
    await flush();
    fake.say("switch to Max");
    await flush();
    endCall();
    fake.speeches[0]?.resolve();
    await flush();
    expect(ring).not.toHaveBeenCalled();
  });

  it("mutes instead of ringing when the hand-over line is refused for consent", async () => {
    const fake = fakes();
    const ring = vi.fn();
    startCall(
      { botId: "bot-1", botName: "Ada", switchBot: () => ({ name: "Max", ring }) },
      fake.deps,
    );
    await flush();
    fake.say("switch to Max");
    await flush();
    fake.speeches[0]?.reject(new AiConsentBlocked("consent denied"));
    await flush();
    expect(ring).not.toHaveBeenCalled();
    expect(fake.closeCall).not.toHaveBeenCalled();
    expect(getSnapshot()).toMatchObject({ muted: true, caption: "consent denied" });
    toggleMute();
    await flush();
    fake.replyWith("new-reply", "Back on the line.");
    expect(fake.spoken.at(-1)).toBe("Back on the line.");
  });

  it("does not ring the other bot when the caller hangs up before the hand-over is spoken", async () => {
    const endCue = deferred<void>();
    const fake = fakes();
    const ring = vi.fn();
    startCall(
      { botId: "bot-1", botName: "Ada", switchBot: () => ({ name: "Max", ring }) },
      {
        ...fake.deps,
        cue: async (cue) => {
          fake.cues.push(cue);
          if (cue === "end") await endCue.promise;
        },
      },
    );
    await flush();
    fake.say("switch to Max");
    await flush();
    endCall();
    endCue.resolve();
    await flush();
    expect(fake.spoken).toEqual([]);
    expect(ring).not.toHaveBeenCalled();
  });

  it("does not let an earlier closing cue start the waiting sound for a later turn", async () => {
    const fake = fakes({ onDevice: true });
    const endCues: Array<Deferred<void>> = [];
    startCall(
      { botId: "bot-1", botName: "Ada", transcribe: false },
      {
        ...fake.deps,
        cue: async (cue) => {
          fake.cues.push(cue);
          if (cue !== "end") return;
          const pending = deferred<void>();
          endCues.push(pending);
          await pending.promise;
        },
      },
    );
    await flush();
    fake.hear("status please");
    await flush();
    expect(fake.waits).toEqual(["preload"]);

    fake.replyWith("message-1", "It is green.");
    expect(fake.waits).toEqual(["preload", "stop"]);
    fake.speeches[0]?.resolve();
    await flush();

    fake.hear("and the tests");
    await flush();
    expect(getSnapshot()?.phase).toBe("thinking");
    expect(endCues).toHaveLength(2);

    endCues[0]?.resolve();
    await flush();
    expect(fake.waits).toEqual(["preload", "stop"]);

    endCues[1]?.resolve();
    await flush();
    expect(fake.waits).toEqual(["preload", "stop", "start"]);
  });

  it("plays the closing cue once the caller's turn is heard", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    expect(fake.cues).toEqual(["start"]);
    fake.say("status please");
    await flush();
    expect(fake.cues).toEqual(["start", "end"]);
    expect(fake.send).toHaveBeenCalledOnce();
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

  it("stops the playing reply when the caller hangs up", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("status please");
    await flush();
    fake.replyWith("message-1", "It is green.");
    expect(getSnapshot()?.phase).toBe("speaking");

    endCall();
    expect(fake.stopSpeaking).toHaveBeenCalledOnce();
    expect(getSnapshot()).toBeNull();

    // Hanging up again with no call active must not stop speech a second time.
    endCall();
    expect(fake.stopSpeaking).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight spoken turn before closing the call server-side", async () => {
    const fake = fakes();
    const pendingSend = deferred<string | undefined>();
    fake.send.mockReturnValueOnce(pendingSend.promise);
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    fake.say("status please");
    await flush();
    const callId = callIdFromClientNonce(fake.send.mock.calls[0]?.[2]);

    endCall();
    expect(fake.closeCall).not.toHaveBeenCalled();

    pendingSend.resolve("run-1");
    await pendingSend.promise;
    await flush();
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

  it("keeps the microphone closed until the opening cue ends and the greeting starts", async () => {
    const cue = deferred<void>();
    const fake = fakes();
    const startedCallId = startCall(
      { botId: "bot-1", botName: "Ada", transcribe: false, greeting: "Hello, Ada here." },
      { ...fake.deps, cue: () => cue.promise },
    );
    await flush();

    setCallProviderTranscribe(true, startedCallId);
    toggleMute();
    toggleMute();
    await flush();
    expect(fake.recordings).toHaveLength(0);
    expect(fake.spoken).toEqual([]);

    cue.resolve();
    await flush();
    expect(fake.spoken).toEqual(["Hello, Ada here."]);
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

    // The replacement startCall hangs the old call up, which stops its speech. Keep that
    // one Stop from settling the reply, so the refusal below reaches the stale catch.
    fake.stopSpeaking.mockImplementationOnce(() => undefined);
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

describe("mobile call speech locales", () => {
  /** Part of what iOS recognizes, which starts only for a tag it lists exactly. */
  const IOS_LOCALES = [
    "de-AT",
    "de-DE",
    "en-GB",
    "en-US",
    "es-419",
    "es-CL",
    "es-ES",
    "es-MX",
    "ja-JP",
    "nl-NL",
    "ru-RU",
    "zh-CN",
    "zh-TW",
  ];
  let previousLocale: UiLocale;

  beforeEach(() => {
    previousLocale = getActiveUiLocale();
    vi.useFakeTimers();
  });

  afterEach(() => {
    endCall();
    stopDictation();
    setSpeechRecognizer(null);
    activateUiLocale(previousLocale);
    device.languageTag = "en-US";
    device.os = "ios";
    vi.useRealTimers();
  });

  it.each([
    ["en", "ios", "en-US", "en-US"],
    ["de", "ios", "en-US", "de-DE"],
    ["nl", "ios", "en-US", "nl-NL"],
    ["ja", "ios", "en-US", "ja-JP"],
    ["ru", "ios", "en-US", "ru-RU"],
    ["zh-CN", "ios", "en-US", "zh-CN"],
    // The app ships no Spanish, so a Spanish phone runs it in English.
    ["en", "ios", "es-CL", "es-CL"],
    ["en", "ios", "es-ES", "es-ES"],
    ["en", "ios", "es-419", "es-MX"],
    ["en", "android", "it-IT", "it-IT"],
    ["en", "ios", "es-AR", "es-MX"],
    ["en", "android", "es-AR", "es-AR"],
    ["de", "ios", "de-AT", "de-AT"],
    ["en", "ios", "ru-RU", "ru-RU"],
  ] as const)(
    "recognizes a %s call on an %s %s phone with %s and sends its live transcript after silence",
    async (locale, os, phone, lang) => {
      device.os = os;
      device.languageTag = phone;
      const listeners = new Map<string, (payload: never) => void>();
      const start = vi.fn();
      const recognizer: SpeechRecognizer = {
        start,
        stop: vi.fn(),
        abort: vi.fn(),
        isRecognitionAvailable: () => true,
        requestPermissionsAsync: async () => ({ granted: true }),
        getSupportedLocales: async () => ({ locales: IOS_LOCALES }),
        addListener: (event, listener) => {
          listeners.set(event, listener as (payload: never) => void);
          return { remove: () => void listeners.delete(event) };
        },
      };
      setSpeechRecognizer(recognizer);
      activateUiLocale(locale);
      const fake = fakes();
      const { dictate: _dictate, ...deps } = fake.deps;
      startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, deps);
      await vi.advanceTimersByTimeAsync(0);

      expect(start).toHaveBeenCalledOnce();
      expect.soft(start).toHaveBeenCalledWith({ lang, interimResults: true, continuous: true });
      listeners.get("result")?.({
        isFinal: false,
        results: [{ transcript: "status please" }],
      } as never);
      expect(getSnapshot()).toMatchObject({ phase: "listening", heard: "status please" });
      expect(fake.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(ENDPOINT_SILENCE_MS);

      expect(fake.send).toHaveBeenCalledOnce();
      expect(fake.send).toHaveBeenCalledWith(
        "bot-1",
        "status please",
        expect.stringMatching(/^call:/),
      );
      expect(getSnapshot()).toMatchObject({ phase: "thinking", heard: "status please" });
      expect(fake.recordings).toHaveLength(0);
    },
  );
});

describe("mobile call recognition recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    endCall();
    stopDictation();
    setSpeechRecognizer(null);
    vi.useRealTimers();
  });

  async function greetedCall(transcribe = false, startThrows = false) {
    const listeners = new Map<string, (payload: never) => void>();
    const start = vi.fn();
    if (startThrows)
      start.mockImplementationOnce(() => {
        throw new Error("recognizer unavailable");
      });
    setSpeechRecognizer({
      start,
      stop: vi.fn(),
      abort: vi.fn(),
      isRecognitionAvailable: () => true,
      requestPermissionsAsync: async () => ({ granted: true }),
      getSupportedLocales: async () => ({ locales: [] }),
      addListener: (event, listener) => {
        listeners.set(event, listener as (payload: never) => void);
        return { remove: () => void listeners.delete(event) };
      },
    });
    const fake = fakes();
    const { dictate: _dictate, ...deps } = fake.deps;
    startCall({ botId: "bot-1", botName: "Bot", greeting: "Hello there.", transcribe }, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(start).not.toHaveBeenCalled();
    fake.speeches[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledOnce();
    return {
      ...fake,
      start,
      emit: (event: string, payload: unknown = null) => listeners.get(event)?.(payload as never),
    };
  }

  it("re-arms after empty sessions following the greeting, then sends speech", async () => {
    const fake = await greetedCall();
    for (let cycle = 0; cycle < 4; cycle += 1) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        fake.emit("end");
        await vi.advanceTimersByTimeAsync(2_000);
      }
      expect(fake.start).toHaveBeenCalledTimes(1 + (cycle + 1) * 6);
      expect(getSnapshot()?.phase).toBe("listening");
    }
    const starts = fake.start.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.start).toHaveBeenCalledTimes(starts);
    fake.emit("result", { isFinal: false, results: [{ transcript: "status please" }] });
    await vi.advanceTimersByTimeAsync(ENDPOINT_SILENCE_MS);
    expect(fake.send).toHaveBeenCalledExactlyOnceWith(
      "bot-1",
      "status please",
      expect.stringMatching(/^call:/),
    );

    fake.replyWith("message-1", "The task is ready.");
    await vi.advanceTimersByTimeAsync(0);
    fake.emit("result", { isFinal: false, results: [{ transcript: "actually hang on" }] });
    await vi.advanceTimersByTimeAsync(INTERIM_BARGE_IN_MS);
    expect(fake.stopSpeaking).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(ENDPOINT_SILENCE_MS);
    expect(fake.send).toHaveBeenLastCalledWith(
      "bot-1",
      "actually hang on",
      expect.stringMatching(/^call:/),
    );
  });

  it("sends a turn after a client error following the greeting", async () => {
    const fake = await greetedCall();
    fake.emit("error", { error: "client" });
    fake.emit("end");
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.start).toHaveBeenCalledTimes(2);
    fake.emit("result", { isFinal: true, results: [{ transcript: "status please" }] });
    await vi.advanceTimersByTimeAsync(ENDPOINT_SILENCE_MS);
    expect(fake.send).toHaveBeenCalledExactlyOnceWith(
      "bot-1",
      "status please",
      expect.stringMatching(/^call:/),
    );
    expect(fake.recordings).toHaveLength(0);
  });

  it("falls back to recording only after repeated empty network failures", async () => {
    const fake = await greetedCall(true);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      fake.emit("error", { error: "network" });
      expect(fake.recordings).toHaveLength(0);
      fake.emit("end");
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(fake.start).toHaveBeenCalledTimes(6);
    expect(fake.recordings).toHaveLength(1);
    fake.say("status please");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.send).toHaveBeenCalledOnce();
  });

  it("backs off even when every native start immediately ends", async () => {
    const fake = await greetedCall();
    fake.start.mockImplementation(() => fake.emit("end"));
    fake.emit("end");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.start.mock.calls.length).toBeGreaterThan(6);
    // Each empty cycle still waits through the 250, 500, 1000, 2000, 2000 ms backoff.
    expect(fake.start.mock.calls.length).toBeLessThanOrEqual(1 + 6 * Math.ceil(60_000 / 5_750));
    expect(getSnapshot()?.phase).toBe("listening");
    expect(fake.recordings).toHaveLength(0);
  });

  it("falls back when the first start throws without reviving the failed session", async () => {
    const fake = await greetedCall(true, true);
    expect(fake.recordings).toHaveLength(1);
    fake.say("status please");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.send).toHaveBeenCalledOnce();
    fake.replyWith("message-1", "The task is ready.");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.recordings).toHaveLength(1);
    fake.speeches[1]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.recordings).toHaveLength(2);
    expect(fake.start).toHaveBeenCalledOnce();
  });

  it("falls back when restarting throws and keeps the new microphone open", async () => {
    const fake = await greetedCall(true);
    fake.start.mockImplementationOnce(() => {
      throw new Error("recognizer unavailable");
    });
    fake.emit("end");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.recordings).toHaveLength(1);
    fake.say("status please");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.send).toHaveBeenCalledOnce();
  });

  it("defers recording after a recognition failure during playback", async () => {
    const fake = await greetedCall(true);
    fake.emit("result", { isFinal: true, results: [{ transcript: "status please" }] });
    await vi.advanceTimersByTimeAsync(ENDPOINT_SILENCE_MS);
    fake.replyWith("message-1", "The task is ready.");
    await vi.advanceTimersByTimeAsync(0);
    fake.emit("error", { error: "language-not-supported" });
    await vi.advanceTimersByTimeAsync(0);
    expect(getSnapshot()?.phase).toBe("speaking");
    expect(fake.recordings).toHaveLength(0);
    fake.speeches[1]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.recordings).toHaveLength(1);
    fake.say("another task please");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.send).toHaveBeenLastCalledWith(
      "bot-1",
      "another task please",
      expect.stringMatching(/^call:/),
    );
  });

  it.each(["mute", "hang-up"])("does not re-arm after %s", async (action) => {
    const fake = await greetedCall();
    fake.emit("end");
    if (action === "mute") toggleMute();
    else endCall();
    fake.emit("error", { error: "not-allowed" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.start).toHaveBeenCalledOnce();
    expect(fake.recordings).toHaveLength(0);
  });

  it.each(["not-allowed", "language-not-supported"])(
    "falls back to recording after %s following the greeting",
    async (error) => {
      const fake = await greetedCall(true);
      fake.emit("error", { error });
      fake.emit("end");
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.recordings).toHaveLength(1);
      fake.say("status please");
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.send).toHaveBeenCalledExactlyOnceWith(
        "bot-1",
        "status please",
        expect.stringMatching(/^call:/),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fake.start).toHaveBeenCalledOnce();
    },
  );

  it.each(["not-allowed", "language-not-supported"])(
    "shows the existing settings caption after %s without transcription",
    async (error) => {
      const fake = await greetedCall();
      fake.emit("error", { error });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getSnapshot()).toMatchObject({
        phase: "listening",
        caption:
          "Allow speech recognition in Settings, or connect ElevenLabs, OpenAI, or Fish Audio.",
      });
      expect(fake.start).toHaveBeenCalledOnce();
      expect(fake.recordings).toHaveLength(0);
    },
  );
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

  it("keeps the bot's farewell when the barged-out reply settles late", async () => {
    const fake = fakes({ onDevice: true });
    const id = startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await tick();
    fake.hear("status please");
    await tick();
    fake.replyWith("message-1", "It is green.");
    await tick();
    expect(fake.speeches).toHaveLength(1);

    // Model hosted preparation: the stop for the barge-in does not settle the speech.
    fake.stopSpeaking.mockImplementationOnce(() => undefined);
    fake.interim("actually hang on");
    await tick(INTERIM_BARGE_IN_MS);
    expect(fake.stopSpeaking).toHaveBeenCalledOnce();
    expect(getSnapshot()?.phase).toBe("listening");

    fake.endedCall(id, "Talk soon.");
    await tick();
    expect(fake.spoken).toEqual(["It is green.", "Talk soon."]);

    // The barged-out reply settles after the farewell started: it must not hang up.
    fake.speeches[0]?.resolve();
    await tick();
    expect(getSnapshot()?.phase).toBe("speaking");
    expect(fake.stopSpeaking).toHaveBeenCalledOnce();

    fake.speeches[1]?.resolve();
    await tick();
    expect(getSnapshot()).toBeNull();
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

  it("stops the call feed when the server refuses it but keeps retrying a 503", async () => {
    const { rpc, subscribeThread } = await import("./api");
    const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
    vi.mocked(rpc).mockResolvedValue({ cursor: 3, messages: [], run: null } as never);
    vi.mocked(subscribeThread)
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(403))
      .mockResolvedValue(undefined as never);
    const fake = fakes();
    const { watch: _watch, ...deps } = fake.deps;
    startCall({ botId: "bot-1", botName: "Ada" }, deps);
    await tick();
    expect(subscribeThread).toHaveBeenCalledTimes(1);

    await tick(500);
    expect(subscribeThread).toHaveBeenCalledTimes(2);
    await tick(20_000);
    expect(subscribeThread).toHaveBeenCalledTimes(2);
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

describe("mobile call microphone after hang-up", () => {
  afterEach(() => {
    endCall();
    stopDictation();
    setSpeechRecognizer(null);
    audio.permission = Promise.resolve({ granted: true });
    audio.prepared = Promise.resolve();
    audio.record.mockClear();
    audio.release.mockClear();
    audio.setAudioMode.mockClear();
  });

  it("keeps the next call's recognition when a hung-up call's permission resolves late", async () => {
    const permissions: Array<Deferred<{ granted: boolean }>> = [];
    const start = vi.fn();
    const abort = vi.fn();
    setSpeechRecognizer({
      start,
      stop: vi.fn(),
      abort,
      isRecognitionAvailable: () => true,
      requestPermissionsAsync: () => {
        const next = deferred<{ granted: boolean }>();
        permissions.push(next);
        return next.promise;
      },
      getSupportedLocales: async () => ({ locales: [] }),
      addListener: () => ({ remove: () => undefined }),
    });
    const { dictate: _first, ...firstDeps } = fakes().deps;
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, firstDeps);
    await flush();
    expect(permissions).toHaveLength(1);
    endCall();

    const { dictate: _second, ...secondDeps } = fakes().deps;
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, secondDeps);
    await flush();
    permissions[1]?.resolve({ granted: true });
    await flush();
    expect(start).toHaveBeenCalledOnce();

    permissions[0]?.resolve({ granted: true });
    await flush();

    expect(abort).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
  });

  it.each(["permission", "prepared"] as const)(
    "never starts recording after the call ends while %s is pending",
    async (step) => {
      const pending = deferred<never>();
      audio[step] = pending.promise;
      const { record: _record, ...deps } = fakes().deps;
      startCall({ botId: "bot-1", botName: "Ada" }, deps);
      await flush();

      endCall();
      pending.resolve((step === "permission" ? { granted: true } : undefined) as never);
      await flush();

      expect(audio.record).not.toHaveBeenCalled();
      if (step === "prepared") expect(audio.release).toHaveBeenCalledOnce();
    },
  );

  it("leaves the next call's recording on when a hung-up call's recorder finishes preparing", async () => {
    const preparing = deferred<void>();
    audio.prepared = preparing.promise;
    const { record: _first, ...firstDeps } = fakes().deps;
    startCall({ botId: "bot-1", botName: "Ada" }, firstDeps);
    await flush();
    endCall();

    audio.prepared = Promise.resolve();
    const { record: _second, ...secondDeps } = fakes().deps;
    startCall({ botId: "bot-1", botName: "Ada" }, secondDeps);
    await flush();
    expect(audio.record).toHaveBeenCalledOnce();
    audio.setAudioMode.mockClear();

    preparing.resolve();
    await flush();

    expect(audio.release).toHaveBeenCalledOnce();
    expect(audio.setAudioMode).not.toHaveBeenCalledWith(
      expect.objectContaining({ allowsRecording: false }),
    );
  });

  it("does not ask for the microphone when the call ends during the audio import", async () => {
    vi.resetModules();
    const requestPermission = vi.fn(async () => ({ granted: true }));
    let finishImport!: () => void;
    let importStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      importStarted = resolve;
    });
    const pendingImport = new Promise<void>((resolve) => {
      finishImport = resolve;
    });
    vi.doMock("expo-audio", async () => {
      importStarted();
      await pendingImport;
      return {
        AudioModule: { requestRecordingPermissionsAsync: requestPermission },
        RecordingPresets: { HIGH_QUALITY: {} },
        setAudioModeAsync: async () => undefined,
      };
    });
    try {
      const session = await import("./call-session");
      const { record: _record, ...deps } = fakes().deps;
      session.startCall({ botId: "bot-1", botName: "Ada" }, deps);
      await started;
      session.endCall();
      finishImport();
      await flush();
      expect(requestPermission).not.toHaveBeenCalled();
    } finally {
      vi.doMock("expo-audio", () => expoAudioMock());
      vi.resetModules();
    }
  });
});
