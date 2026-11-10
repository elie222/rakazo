import {
  AiConsentBlocked,
  CALL_FAREWELL_TIMEOUT_MS,
  callIdFromClientNonce,
  INTERIM_BARGE_IN_MS,
} from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hapticImpact, hapticSuccess } from "./haptics";

vi.mock("./haptics", () => ({ hapticImpact: vi.fn(), hapticSuccess: vi.fn() }));

import type { CallClip, CallDeps, CallEnded, DictationHandlers } from "./call-session";
import {
  ExpectedTurnFailure,
  endCall,
  endCallBeforeSessionEnd,
  getSnapshot,
  hangUp,
  recordClip,
  SIGN_OUT_HANG_UP_MS,
  setCallProviderTranscribe,
  startCall,
  subscribe,
  toggleMute,
} from "./call-session";
import type { SpeechRecognizer } from "./dictation";
import { ENDPOINT_SILENCE_MS, setSpeechRecognizer, stop as stopDictation } from "./dictation";
import { activateUiLocale, getActiveUiLocale } from "./i18n";
import type { MobileSnapshot } from "./mobile-types";
import { reportMobileError } from "./monitoring";
import { saveServerHeaders } from "./server-headers";
import {
  clearSessionToken,
  currentSessionGeneration,
  replaceSessionTokenIfCurrent,
  restoreSessionToken,
  rotateSessionTokenIfCurrent,
  saveSessionToken,
} from "./session";
import type { UiLocale } from "./ui-locale";
import { ensureVoiceConsent } from "./voice";

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
const files = vi.hoisted(() => ({ base64: async () => "" }));
vi.mock("expo-file-system", () => ({
  File: class {
    async base64() {
      return files.base64();
    }
    delete() {}
  },
  Paths: {},
}));
vi.mock("./voice", () => ({
  createSpeechOwner: () => Symbol("SpeechOwner"),
  ensureVoiceConsent: vi.fn(async () => undefined),
  setCallAudio: vi.fn(async () => undefined),
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
}));
vi.mock("./call-sounds", () => ({ playCallCue: vi.fn() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("./live-notifications", () => ({ stopLiveNotifications: vi.fn(async () => undefined) }));
vi.mock("./thread-feedback", () => ({ clearFailedSends: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
// The production recorder, with each step it awaits held by the test.
const audio = vi.hoisted(() => ({
  permission: Promise.resolve({ granted: true }),
  prepared: Promise.resolve(),
  record: vi.fn(),
  release: vi.fn(),
  setAudioMode: vi.fn(),
  status: {} as { metering?: number },
  uri: null as string | null,
}));
const expoAudioMock = vi.hoisted(() => () => ({
  AudioModule: {
    requestRecordingPermissionsAsync: () => audio.permission,
    AudioRecorder: class {
      uri = audio.uri;
      prepareToRecordAsync = () => audio.prepared;
      record = audio.record;
      stop = async () => undefined;
      release = audio.release;
      getStatus = () => audio.status;
    },
  },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: async (mode: unknown) => audio.setAudioMode(mode),
}));
vi.mock("expo-audio", () => expoAudioMock());
vi.mock("./api-auth", () => ({}));
vi.mock("./api", () => ({
  applyMobileThreadEvent: vi.fn(),
  // The live session's context, so the production recorder's voice consent check can run.
  captureApiRequestContext: vi.fn(async () => ({
    apiBase: "https://api.test",
    headers: {},
    sessionGeneration: (await import("./session")).currentSessionGeneration(),
  })),
  rpc: vi.fn(),
}));
vi.mock("./mobile-types", () => ({
  blockText: vi.fn(),
}));
vi.mock("./api-server", () => ({
  configureSessionEndHangUp: vi.fn(),
}));
vi.mock("./api-live", () => ({
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

function idleThread(botId: string): MobileSnapshot {
  return { threadId: "thread-1", botId, cursor: 0, olderCursor: null, run: null, messages: [] };
}

function fakes(opts: { onDevice?: boolean; loadThread?: boolean } = {}) {
  const recordings: Array<Deferred<CallClip | null>> = [];
  const signals: AbortSignal[] = [];
  const speeches: Array<Deferred<void>> = [];
  const send = vi.fn(
    async (_botId: string, _text: string, _clientNonce: string): Promise<string | undefined> =>
      "run-1",
  );
  const answer = vi.fn(
    async (
      _botId: string,
      _ask: { runId: string; messageId: string; answer: string },
      _clientNonce: string,
    ) => undefined,
  );
  const followUp = vi.fn(async (_botId: string, _text: string, _clientNonce: string) => undefined);
  const closeCall = vi.fn(async (_botId: string, _callId: string) => undefined);
  const unwatch = vi.fn();
  let threadUpdate: (thread: MobileSnapshot) => void = () => undefined;
  let reply: (messageId: string, text: string, runId?: string) => void = () => undefined;
  let ended: (ended: CallEnded) => void = () => undefined;
  const spoken: string[] = [];
  let handlers: DictationHandlers | null = null;
  const stopSpeaking = vi.fn(() => {
    speeches[speeches.length - 1]?.resolve();
  });
  const cues: string[] = [];
  const waits: string[] = [];
  const audioSession: boolean[] = [];
  const deps: CallDeps = {
    audio: async (active) => {
      audioSession.push(active);
    },
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
    answer,
    followUp,
    endCall: closeCall,
    speak: (_botId, text) => {
      spoken.push(text);
      const next = deferred<void>();
      speeches.push(next);
      return next.promise;
    },
    watch: (botId, onReply, onCallEnded, onThread) => {
      reply = onReply;
      ended = onCallEnded;
      threadUpdate = onThread;
      // The real watcher hands over the loaded thread first; the microphone waits for it.
      if (opts.loadThread !== false) onThread(idleThread(botId));
      return unwatch;
    },
  };
  return {
    deps,
    cues,
    waits,
    audioSession,
    stopSpeaking,
    interim: (text: string) => handlers?.onInterim(text),
    hear: (text: string) => handlers?.onFinal(text),
    recordings,
    signals,
    speeches,
    spoken,
    send,
    answer,
    followUp,
    closeCall,
    unwatch,
    thread: (thread: MobileSnapshot) => threadUpdate(thread),
    say: (text: string) =>
      recordings[recordings.length - 1]?.resolve({ base64: text, mimeType: "audio/m4a" }),
    replyWith: (messageId: string, text: string, runId?: string) => reply(messageId, text, runId),
    endedCall: (callId: string | undefined, farewell?: string) => ended({ callId, farewell }),
  };
}

afterEach(() => endCall());

describe("mobile call session", () => {
  it("confirms connection and explicit hang-up once, without buzzing for an absent or aborted call", async () => {
    vi.mocked(hapticImpact).mockClear();
    vi.mocked(hapticSuccess).mockClear();
    hangUp();
    expect(hapticImpact).not.toHaveBeenCalled();
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    expect(hapticSuccess).toHaveBeenCalledTimes(1);
    expect(hapticImpact).not.toHaveBeenCalled();
    hangUp();
    hangUp();
    expect(hapticImpact).toHaveBeenCalledTimes(1);
    const opening = deferred<void>();
    startCall({ botId: "bot-2", botName: "Bob" }, { ...fake.deps, cue: () => opening.promise });
    endCall();
    opening.resolve();
    await flush();
    expect(hapticSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not confirm a connection when the remote farewell starts during its opening cue", async () => {
    const fake = fakes();
    const opening = deferred<void>();
    const id = startCall(
      { botId: "bot-1", botName: "Ada" },
      { ...fake.deps, cue: () => opening.promise },
    );
    vi.mocked(hapticSuccess).mockClear();
    fake.endedCall(id, "Goodbye.");
    opening.resolve();
    await flush();
    expect(hapticSuccess).not.toHaveBeenCalled();
    expect(fake.spoken).toEqual(["Goodbye."]);
  });

  it("keeps shared teardown and call replacement silent", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    vi.mocked(hapticImpact).mockClear();
    vi.mocked(hapticSuccess).mockClear();
    startCall({ botId: "bot-2", botName: "Max" }, fake.deps);
    await flush();
    expect(hapticImpact).not.toHaveBeenCalled();
    expect(hapticSuccess).toHaveBeenCalledOnce();
    vi.mocked(hapticSuccess).mockClear();
    endCall();
    expect(hapticImpact).not.toHaveBeenCalled();
    expect(hapticSuccess).not.toHaveBeenCalled();
  });

  it("keeps remote termination silent", async () => {
    const fake = fakes();
    const id = startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    vi.mocked(hapticImpact).mockClear();
    vi.mocked(hapticSuccess).mockClear();
    fake.endedCall(id);
    expect(getSnapshot()).toBeNull();
    expect(hapticImpact).not.toHaveBeenCalled();
    expect(hapticSuccess).not.toHaveBeenCalled();
  });

  it("keeps a remote farewell timeout silent", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakes();
      const id = startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
      await vi.advanceTimersByTimeAsync(0);
      vi.mocked(hapticImpact).mockClear();
      vi.mocked(hapticSuccess).mockClear();
      fake.endedCall(id, "Talk soon.");
      await vi.advanceTimersByTimeAsync(CALL_FAREWELL_TIMEOUT_MS);
      expect(getSnapshot()).toBeNull();
      expect(hapticImpact).not.toHaveBeenCalled();
      expect(hapticSuccess).not.toHaveBeenCalled();
    } finally {
      endCall();
      vi.useRealTimers();
    }
  });

  it("retains an answered incoming call's id through speech, messages and hang-up", async () => {
    const fake = fakes();
    const id = startCall(
      { botId: "bot-1", botName: "Caller", answered: { callId: "incoming-1" } },
      fake.deps,
    );
    expect(id).toBe("incoming-1");
    await flush();
    fake.say("Hello");
    await flush();
    expect(fake.send).toHaveBeenCalledWith("bot-1", "Hello", expect.stringContaining("incoming-1"));
    endCall();
    await flush();
    expect(fake.closeCall).toHaveBeenCalledWith("bot-1", "incoming-1");
  });

  it("holds the call's audio session from pickup to hang-up", async () => {
    const fake = fakes();
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    expect(fake.audioSession).toEqual([true]);
    expect(fake.cues).toEqual(["start"]);
    fake.say("status please");
    await flush();
    fake.replyWith("message-1", "The task is ready.");
    fake.speeches[0]?.resolve();
    await flush();
    expect(fake.audioSession).toEqual([true]);
    endCall();
    expect(fake.audioSession).toEqual([true, false]);
  });

  it("reports a call audio failure and still listens", async () => {
    vi.mocked(reportMobileError).mockClear();
    const fake = fakes();
    const failure = new Error("audio session unavailable");
    fake.deps.audio = async () => {
      throw failure;
    };
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    expect(reportMobileError).toHaveBeenCalledWith(failure, "voice.microphone", {
      source: "call-audio",
    });
    expect(fake.recordings).toHaveLength(1);
  });

  it("waits for the server hang-up before the sign-out continues", async () => {
    const fake = fakes();
    const closed = deferred<undefined>();
    fake.closeCall.mockImplementation(() => closed.promise);
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    let finished = false;
    const hangingUp = endCallBeforeSessionEnd().then(() => {
      finished = true;
    });
    await flush();
    expect(fake.closeCall).toHaveBeenCalledWith("bot-1", expect.any(String));
    expect(finished).toBe(false);
    closed.resolve(undefined);
    await hangingUp;
    expect(finished).toBe(true);
  });

  it("stops waiting for the hang-up once the sign-out window passes", async () => {
    const fake = fakes();
    const stuck = deferred<undefined>();
    fake.closeCall.mockImplementation(() => stuck.promise);
    startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
    await flush();
    vi.useFakeTimers();
    try {
      const hangingUp = endCallBeforeSessionEnd();
      let finished = false;
      void hangingUp.then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(SIGN_OUT_HANG_UP_MS - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);
    } finally {
      vi.useRealTimers();
      stuck.resolve(undefined);
      await flush();
    }
  });

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

  describe("answering what the bot is waiting on", () => {
    const waitingOn = (
      blocks: MobileSnapshot["messages"][number]["blocks"],
      status = "waiting_input",
    ): MobileSnapshot => ({
      threadId: "thread-1",
      botId: "bot-1",
      cursor: 4,
      olderCursor: null,
      run: { id: "run-1", status },
      messages: [{ id: "ask-1", runId: "run-1", role: "bot", blocks }],
    });

    it("answers the open question instead of sending a new message", async () => {
      const fake = fakes();
      startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
      await flush();
      fake.thread(waitingOn([{ kind: "ask", text: "Ship it?", status: "pending" }]));
      fake.say("yes");
      await flush();
      expect(fake.send).not.toHaveBeenCalled();
      expect(fake.answer).toHaveBeenCalledWith(
        "bot-1",
        { runId: "run-1", messageId: "ask-1", answer: "yes" },
        expect.stringMatching(/^call:/),
      );
      // Only the answered run's reply is spoken.
      fake.replyWith("other", "Something else", "run-2");
      fake.replyWith("reply", "Shipped.", "run-1");
      expect(fake.spoken).toEqual(["Shipped."]);
    });

    it("speaks the answered run's reply even before the answer request returns", async () => {
      const fake = fakes();
      startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
      await flush();
      // An earlier spoken turn started run-0; the question belongs to run-1.
      fake.send.mockResolvedValueOnce("run-0");
      fake.say("start");
      await flush();
      const answered = deferred<undefined>();
      fake.answer.mockReturnValueOnce(answered.promise);
      fake.thread(waitingOn([{ kind: "ask", text: "Ship it?", status: "pending" }]));
      fake.replyWith("start-reply", "Started.", "run-0");
      fake.speeches[0]?.resolve();
      await flush();
      fake.say("yes");
      await flush();
      fake.replyWith("reply", "Shipped.", "run-1");
      expect(fake.spoken).toEqual(["Started.", "Shipped."]);
      answered.resolve(undefined);
    });

    it("speaks a follow-up's reply even before the follow-up request returns", async () => {
      const fake = fakes();
      startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
      await flush();
      fake.send.mockResolvedValueOnce("run-0");
      fake.say("start");
      await flush();
      const followed = deferred<undefined>();
      fake.followUp.mockReturnValueOnce(followed.promise);
      fake.thread(waitingOn([], "running"));
      fake.replyWith("start-reply", "On it.", "run-0");
      fake.speeches[0]?.resolve();
      await flush();
      fake.say("also check the tests");
      await flush();
      fake.replyWith("more", "Tests pass.", "run-5");
      expect(fake.spoken).toEqual(["On it.", "Tests pass."]);
      followed.resolve(undefined);
    });

    it("steers a run that is still working", async () => {
      const fake = fakes();
      startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
      await flush();
      fake.thread(waitingOn([], "running"));
      fake.say("also check the tests");
      await flush();
      expect(fake.send).not.toHaveBeenCalled();
      expect(fake.followUp).toHaveBeenCalledWith(
        "bot-1",
        "also check the tests",
        expect.stringMatching(/^call:/),
      );
    });

    it("sends an approval to the screen and keeps listening", async () => {
      const fake = fakes();
      startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
      await flush();
      fake.thread(
        waitingOn([
          {
            kind: "ask",
            text: "Send the email?",
            status: "pending",
            approvalEffectId: "effect-1",
            actions: [
              { id: "allow", label: "Allow" },
              { id: "deny", label: "Deny" },
            ],
          },
        ]),
      );
      fake.say("yes");
      await flush();
      expect(fake.send).not.toHaveBeenCalled();
      expect(fake.answer).not.toHaveBeenCalled();
      expect(getSnapshot()).toMatchObject({
        phase: "listening",
        caption: "Approve or deny it on screen.",
      });
      expect(fake.recordings).toHaveLength(2);
    });

    it("ignores a snapshot from an ended call's watcher", async () => {
      const fake = fakes();
      const threadCallbacks: Array<(thread: MobileSnapshot) => void> = [];
      const watch = fake.deps.watch;
      fake.deps.watch = (botId, onReply, onEnded, onThread) => {
        threadCallbacks.push(onThread);
        return watch(botId, onReply, onEnded, onThread);
      };
      startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
      await flush();
      hangUp();
      startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
      await flush();
      const listening = fake.recordings.length;
      threadCallbacks[0]?.(
        waitingOn([{ kind: "ask", text: "Code?", input: "secret", status: "pending" }]),
      );
      expect(fake.signals.at(-1)?.aborted).toBe(false);
      fake.say("hello");
      await flush();
      expect(fake.send).toHaveBeenCalledWith("bot-1", "hello", expect.stringMatching(/^call:/));
      expect(fake.recordings.length).toBeGreaterThanOrEqual(listening);
    });

    it("tells the caller to enter a code when the thread loads with one pending", async () => {
      const fake = fakes({ loadThread: false });
      startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
      await flush();
      fake.thread(waitingOn([{ kind: "ask", text: "Code?", input: "secret", status: "pending" }]));
      expect(fake.recordings).toHaveLength(0);
      expect(getSnapshot()?.caption).toBe("Hang up, then enter the code on screen.");
    });

    it("keeps the microphone shut until it knows whether the bot waits on a code", async () => {
      const fake = fakes({ loadThread: false });
      startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
      await flush();
      expect(fake.recordings).toHaveLength(0);
      fake.thread(idleThread("bot-1"));
      await flush();
      expect(fake.recordings).toHaveLength(1);
    });

    it("keeps the microphone shut for a code another waiting run asks for", async () => {
      const fake = fakes();
      startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
      await flush();
      expect(fake.recordings).toHaveLength(1);
      fake.thread({
        threadId: "thread-1",
        botId: "bot-1",
        cursor: 5,
        olderCursor: null,
        run: { id: "run-1", status: "running" },
        activeRuns: [
          { id: "run-1", status: "running" },
          { id: "run-2", status: "waiting_input" },
        ],
        messages: [
          {
            id: "code",
            runId: "run-2",
            role: "bot",
            blocks: [{ kind: "ask", text: "Code?", input: "secret", status: "pending" }],
          },
        ],
      });
      expect(fake.signals[0]?.aborted).toBe(true);
      expect(getSnapshot()?.caption).toBe("Hang up, then enter the code on screen.");
      fake.say("one two three");
      await flush();
      expect(fake.send).not.toHaveBeenCalled();
      expect(fake.followUp).not.toHaveBeenCalled();
    });

    it("keeps the microphone shut while the bot waits on a code typed on screen", async () => {
      const fake = fakes();
      startCall({ botId: "bot-1", botName: "Ada" }, fake.deps);
      await flush();
      expect(fake.recordings).toHaveLength(1);
      const secret = waitingOn([
        { kind: "ask", text: "Code?", input: "secret", status: "pending" },
      ]);
      fake.thread(secret);
      expect(fake.signals[0]?.aborted).toBe(true);
      // The caller is told what to do without having to speak first.
      expect(getSnapshot()?.caption).toBe("Hang up, then enter the code on screen.");
      fake.say("one two three");
      await flush();
      expect(fake.send).not.toHaveBeenCalled();
      expect(fake.recordings).toHaveLength(1);

      fake.thread({ ...secret, run: { id: "run-1", status: "running" }, messages: [] });
      await flush();
      expect(fake.recordings).toHaveLength(2);
      expect(getSnapshot()?.caption).toBe("");
    });
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

  it("sends the saved server headers on the transcription request", async () => {
    const server = "https://api.example.test";
    await saveServerHeaders(server, { "x-proxy-token": "gate" });
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ text: "transcribed words" })),
    );
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const fake = fakes();
      const { transcribe: _transcribe, ...deps } = fake.deps;
      startCall(
        {
          botId: "bot-1",
          botName: "Ada",
          requestContext: {
            apiBase: server,
            headers: { authorization: "Bearer token" },
            sessionGeneration: currentSessionGeneration(),
          },
        },
        deps,
      );
      await flush();
      fake.say("spoken words");
      await flush();
      expect(fake.send).toHaveBeenCalledWith("bot-1", "transcribed words", expect.any(String));
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${server}/api/voice/transcribe`);
      const init = fetchImpl.mock.calls[0]?.[1];
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("x-proxy-token")).toBe("gate");
    } finally {
      vi.unstubAllGlobals();
      await saveServerHeaders(server, {});
    }
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
    vi.mocked(hapticImpact).mockClear();
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
    expect(hapticImpact).not.toHaveBeenCalled();
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
      expect
        .soft(start)
        .toHaveBeenCalledWith(
          expect.objectContaining({ lang, interimResults: true, continuous: true }),
        );
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
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        iosCategory: expect.objectContaining({ category: "playAndRecord" }),
      }),
    );
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

  it("records one turn when the first start throws, then tries recognition again", async () => {
    const fake = await greetedCall(true, true);
    expect(fake.recordings).toHaveLength(1);
    fake.say("status please");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.send).toHaveBeenCalledOnce();
    fake.replyWith("message-1", "The task is ready.");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.recordings).toHaveLength(1);
    expect(fake.start).toHaveBeenCalledOnce();
    fake.speeches[1]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.recordings).toHaveLength(1);
    expect(fake.start).toHaveBeenCalledTimes(2);
  });

  it("keeps recording for the call once recognition fails twice in a row", async () => {
    const fake = await greetedCall(true, true);
    fake.say("status please");
    await vi.advanceTimersByTimeAsync(0);
    fake.start.mockImplementationOnce(() => {
      throw new Error("recognizer unavailable");
    });
    fake.replyWith("message-1", "The task is ready.");
    await vi.advanceTimersByTimeAsync(0);
    fake.speeches[1]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.start).toHaveBeenCalledTimes(2);
    expect(fake.recordings).toHaveLength(2);

    fake.say("and the deploy");
    await vi.advanceTimersByTimeAsync(0);
    fake.replyWith("message-2", "It shipped.");
    await vi.advanceTimersByTimeAsync(0);
    fake.speeches[2]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.start).toHaveBeenCalledTimes(2);
    expect(fake.recordings).toHaveLength(3);
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
    const { rpc } = await import("./api");
    const { subscribeThread } = await import("./api-live");
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
    const { rpc } = await import("./api");
    const { subscribeThread } = await import("./api-live");
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

  it("waits muted instead of recording when voice consent is refused without a greeting", async () => {
    const fake = fakes();
    const record = vi
      .fn<CallDeps["record"]>()
      .mockRejectedValueOnce(new AiConsentBlocked("voice consent denied"))
      .mockImplementation(fake.deps.record);
    startCall({ botId: "bot-1", botName: "Ada" }, { ...fake.deps, record });
    await tick();

    expect(record).toHaveBeenCalledOnce();
    expect(fake.recordings).toEqual([]);
    expect(getSnapshot()).toMatchObject({
      phase: "listening",
      muted: true,
      caption: "voice consent denied",
    });
    await tick(20_000);
    expect(record).toHaveBeenCalledOnce();

    toggleMute();
    await tick();
    expect(record).toHaveBeenCalledTimes(2);
    expect(getSnapshot()).toMatchObject({ botId: "bot-1", muted: false });
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
    const { rpc } = await import("./api");
    const { subscribeThread } = await import("./api-live");
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

// Kept above the hang-up describe: its audio-import test resets modules, and the
// production recorder does not work in this file after that reset.
describe("mobile call recording without metering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    audio.permission = Promise.resolve({ granted: true });
    audio.prepared = Promise.resolve();
    audio.record.mockClear();
    audio.release.mockClear();
    audio.setAudioMode.mockClear();
    // A healthy recorder that never reports a level: pure silence is indistinguishable.
    audio.status = {};
    audio.uri = "file://silence.m4a";
    files.base64 = async () => "c2lsZW5jZQ==";
  });
  afterEach(() => {
    endCall();
    vi.useRealTimers();
    audio.status = {};
    audio.uri = null;
    files.base64 = async () => "";
  });

  it("leaves a call's audio mode alone and switches recording on only for a dictated clip", async () => {
    const { record: _record, ...deps } = fakes().deps;
    startCall({ botId: "bot-1", botName: "Ada" }, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.record).toHaveBeenCalledOnce();
    endCall();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(audio.setAudioMode).not.toHaveBeenCalled();

    const stopped = new AbortController();
    const clip = recordClip(new AbortController().signal, stopped.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.setAudioMode).toHaveBeenCalledWith(
      expect.objectContaining({ allowsRecording: true }),
    );
    stopped.abort();
    await vi.advanceTimersByTimeAsync(200);
    await clip;
    expect(audio.setAudioMode).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowsRecording: false }),
    );
  });

  it("ends the clip before the cap and sends nothing for silence", async () => {
    const fake = fakes();
    const transcribe = vi.fn(async (clip: CallClip) => clip.base64);
    const { record: _record, ...deps } = fake.deps;
    startCall({ botId: "bot-1", botName: "Ada" }, { ...deps, transcribe });
    await vi.advanceTimersByTimeAsync(0);
    // The clip ends about a second in, well before the 30 s cap, and the next one starts.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(audio.record.mock.calls.length).toBeGreaterThan(1);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(transcribe).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("keeps speech from a recorder that reports its first level late", async () => {
    const fake = fakes();
    const transcribe = vi.fn(async () => "hello");
    const { record: _record, ...deps } = fake.deps;
    startCall({ botId: "bot-1", botName: "Ada" }, { ...deps, transcribe });
    await vi.advanceTimersByTimeAsync(0);
    // A web recorder reports no level until it has started recording.
    await vi.advanceTimersByTimeAsync(400);
    audio.status = { metering: -10 };
    await vi.advanceTimersByTimeAsync(600);
    // Still the first recording: the late start did not end it.
    expect(audio.record).toHaveBeenCalledTimes(1);
    audio.status = { metering: -60 };
    await vi.advanceTimersByTimeAsync(1_600);

    expect(transcribe).toHaveBeenCalledTimes(1);
    // The recorder sends audio to the voice provider, so it asks before it opens.
    expect(ensureVoiceConsent).toHaveBeenCalled();
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

describe("mobile call on a session change", () => {
  beforeEach(async () => {
    await saveSessionToken("fake-token-a");
    const { captureApiRequestContext, rpc } = await import("./api");
    vi.mocked(captureApiRequestContext).mockImplementation(async () => ({
      apiBase: "https://api.example.test",
      headers: {},
      sessionGeneration: currentSessionGeneration(),
    }));
    vi.mocked(rpc).mockResolvedValue({ runId: "run-1" } as never);
  });

  afterEach(async () => {
    endCall();
    const { captureApiRequestContext, rpc } = await import("./api");
    vi.mocked(captureApiRequestContext).mockReset();
    vi.mocked(rpc).mockReset();
  });

  it.each([
    ["sign-out", () => clearSessionToken()],
    ["sign-in to another account", () => saveSessionToken("fake-token-b")],
    ["server change", () => restoreSessionToken("fake-token-b")],
    [
      "SSO or passkey sign-in",
      () => replaceSessionTokenIfCurrent(currentSessionGeneration(), "fake-token-b"),
    ],
    // Its requests are pinned to the session the server just revoked.
    [
      "password change",
      () => rotateSessionTokenIfCurrent(currentSessionGeneration(), "fake-token-a", "fake-token-b"),
    ],
  ])("ends the call and closes its microphone and feed on %s", async (_name, change) => {
    const fake = fakes({ onDevice: true });
    startCall({ botId: "bot-1", botName: "Ada", transcribe: false }, fake.deps);
    await flush();
    expect(fake.signals).toHaveLength(1);
    vi.mocked(hapticImpact).mockClear();
    vi.mocked(hapticSuccess).mockClear();

    const changing = change();
    // Before the new session is stored, so nothing of the call can reach it.
    expect(getSnapshot()).toBeNull();
    expect(fake.signals[0]?.aborted).toBe(true);
    expect(fake.unwatch).toHaveBeenCalledOnce();
    expect(fake.stopSpeaking).toHaveBeenCalled();
    expect(fake.waits).toContain("release");
    await changing;
    expect(hapticImpact).not.toHaveBeenCalled();
    expect(hapticSuccess).not.toHaveBeenCalled();
  });

  it("does not start a call whose setup began before the session changed", async () => {
    const fake = fakes({ onDevice: true });
    // The caller captures the session, then awaits its voice checks while the account changes.
    const setupSession = currentSessionGeneration();
    await saveSessionToken("fake-token-b");
    const started = startCall(
      { botId: "bot-1", botName: "Ada", transcribe: false, session: setupSession },
      fake.deps,
    );
    await flush();
    expect(started).toBeUndefined();
    expect(getSnapshot()).toBeNull();
    expect(fake.signals).toHaveLength(0);
  });

  it("never sends the old call's turn or hang-up with the next account's session", async () => {
    const { rpc } = await import("./api");
    const fake = fakes();
    const { send: _send, endCall: _endCall, ...deps } = fake.deps;
    startCall({ botId: "bot-1", botName: "Ada" }, deps);
    await flush();

    await clearSessionToken();
    await saveSessionToken("fake-token-b");
    // The caller finishes speaking into the old call, then hangs up.
    fake.say("hello");
    await flush();
    endCall();
    await flush();

    expect(rpc).not.toHaveBeenCalled();
  });

  it("ends the call when the server rejects its session for a turn", async () => {
    const { rpc } = await import("./api");
    vi.mocked(rpc).mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }));
    const fake = fakes();
    const { send: _send, ...deps } = fake.deps;
    startCall({ botId: "bot-1", botName: "Ada" }, deps);
    await flush();
    vi.mocked(hapticImpact).mockClear();
    vi.mocked(hapticSuccess).mockClear();
    fake.say("hello");
    await flush();

    // A rejected session must not leave the microphone listening for the next turn.
    expect(getSnapshot()).toBeNull();
    expect(fake.signals.at(-1)?.aborted).toBe(true);
    expect(hapticImpact).not.toHaveBeenCalled();
    expect(hapticSuccess).not.toHaveBeenCalled();
  });

  it("keeps a hang-up queued behind a send in flight on the call's own session", async () => {
    const { rpc } = await import("./api");
    const sending = deferred<{ runId: string }>();
    vi.mocked(rpc).mockReturnValueOnce(sending.promise as never);
    const fake = fakes();
    const { send: _send, endCall: _endCall, ...deps } = fake.deps;
    const callGeneration = currentSessionGeneration();
    startCall({ botId: "bot-1", botName: "Ada" }, deps);
    await flush();
    fake.say("hello");
    await flush();

    await saveSessionToken("fake-token-b");
    sending.resolve({ runId: "run-1" });
    await flush();
    endCall();
    await flush();

    // Only the send, pinned to the call's session; the hang-up never goes out with the new one.
    expect(vi.mocked(rpc).mock.calls).toEqual([
      [
        "threads/send",
        expect.objectContaining({ botId: "bot-1" }),
        { requestContext: expect.objectContaining({ sessionGeneration: callGeneration }) },
      ],
    ]);
  });

  it("sends the hang-up while the session lasts when signing out during a call", async () => {
    const { rpc } = await import("./api");
    const fake = fakes();
    const { send: _send, endCall: _endCall, ...deps } = fake.deps;
    const callGeneration = currentSessionGeneration();
    startCall({ botId: "bot-1", botName: "Ada" }, deps);
    await flush();

    await endCallBeforeSessionEnd();
    await clearSessionToken();

    expect(rpc).toHaveBeenCalledWith(
      "threads/endCall",
      { botId: "bot-1", callId: expect.any(String) },
      { requestContext: expect.objectContaining({ sessionGeneration: callGeneration }) },
    );
  });

  it("keeps a call's turns and hang-up on the Space it started in", async () => {
    const { captureApiRequestContext, rpc } = await import("./api");
    // The caller pins the Space at call start; the selection then moves to another
    // organization's Space, which changes no session generation.
    vi.mocked(captureApiRequestContext).mockImplementation(async () => ({
      apiBase: "https://api.example.test",
      headers: { "x-rakazo-space-id": "space-b" },
      sessionGeneration: currentSessionGeneration(),
    }));
    const fake = fakes();
    const { send: _send, endCall: _endCall, ...deps } = fake.deps;
    startCall(
      {
        botId: "bot-1",
        botName: "Ada",
        requestContext: {
          apiBase: "https://api.example.test",
          headers: { "x-rakazo-space-id": "space-a" },
          sessionGeneration: currentSessionGeneration(),
        },
      },
      deps,
    );
    await flush();
    fake.say("hello");
    await flush();
    endCall();
    await flush();

    const sent = vi
      .mocked(rpc)
      .mock.calls.map(([path, , options]) => [
        path,
        options?.requestContext?.headers["x-rakazo-space-id"],
      ]);
    expect(sent).toEqual([
      ["threads/send", "space-a"],
      ["threads/endCall", "space-a"],
    ]);
  });
});
