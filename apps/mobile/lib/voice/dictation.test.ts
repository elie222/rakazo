import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportMobileError } from "../platform/monitoring";
import type { SpeechRecognizer } from "./dictation";
import {
  END_OF_SPEECH_GRACE_MS,
  ENDPOINT_SILENCE_MS,
  finishListening,
  listen,
  QUIET_RESTART_MS,
  setSpeechRecognizer,
  stop,
} from "./dictation";

vi.mock("../platform/monitoring", () => ({ reportMobileError: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

type Listener = (payload: never) => void;

/** Longest restart delay the module backs off to. */
const RESTART_CAP_MS = 2_000;

const CALL_SESSION = {
  category: "playAndRecord",
  categoryOptions: ["mixWithOthers", "defaultToSpeaker", "allowBluetooth"],
  mode: "default",
};

function fakeRecognizer() {
  const listeners = new Map<string, Set<Listener>>();
  const start = vi.fn();
  const abort = vi.fn();
  const recognizer: SpeechRecognizer = {
    start,
    stop: vi.fn(),
    abort,
    isRecognitionAvailable: () => true,
    requestPermissionsAsync: async () => ({ granted: true }),
    getSupportedLocales: async () => ({ locales: [] }),
    getAudioSessionCategoryAndOptionsIOS: () => CALL_SESSION,
    addListener: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as Listener);
      listeners.set(event, set);
      return {
        remove: () => {
          set.delete(listener as Listener);
        },
      };
    },
  };
  const emit = (event: string, payload: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])])
      (listener as (p: unknown) => void)(payload);
  };
  return {
    recognizer,
    start,
    abort,
    hear: (transcript: string, isFinal = false) =>
      emit("result", { isFinal, results: [{ transcript, confidence: 0.9 }] }),
    end: () => emit("end", null),
    fail: (error: string) => emit("error", { error, message: error }),
    speechStart: () => emit("speechstart", null),
    speechEnd: () => emit("speechend", null),
    volume: (value: number) => emit("volumechange", { value }),
  };
}

/** Delay a recognizer took to finalise a phrase after reporting the end of speech. */
const FINAL_AFTER_SPEECH_END_MS = 400;

let fake: ReturnType<typeof fakeRecognizer>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(reportMobileError).mockClear();
  fake = fakeRecognizer();
  setSpeechRecognizer(fake.recognizer);
});

afterEach(() => {
  stop();
  setSpeechRecognizer(null);
  vi.useRealTimers();
});

describe("mobile dictation", () => {
  it("uses the supported iOS regional fallback", async () => {
    const locales = vi.fn(async () => ({ locales: ["es-ES", "es-MX"] }));
    fake.recognizer.getSupportedLocales = locales;
    await listen({ lang: "es-AR", onFinal: vi.fn() });
    expect(locales).toHaveBeenCalledWith({});
    expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ lang: "es-MX" }));
  });

  it("keeps the requested locale when the supported list fails", async () => {
    fake.recognizer.getSupportedLocales = async () => {
      throw new Error("Unavailable");
    };
    await listen({ lang: "es-CL", onFinal: vi.fn() });
    expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ lang: "es-CL" }));
  });

  it("closes a mic that hears nothing within its own endpoint", async () => {
    const onGiveUp = vi.fn();
    await listen({ onFinal: vi.fn(), onGiveUp, endpointMs: 30_000 });
    vi.advanceTimersByTime(29_999);
    expect(onGiveUp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onGiveUp).toHaveBeenCalledWith("idle");
  });

  it("does not count a repeated result as new words against its own endpoint", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, endpointMs: 30_000 });
    fake.hear("buy milk");
    for (let repeat = 0; repeat < 3; repeat += 1) {
      vi.advanceTimersByTime(10_000);
      fake.hear("buy milk");
    }
    expect(onFinal).toHaveBeenCalledWith("buy milk");
  });

  it("restarts through a quiet pause until its own endpoint ends it", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, endpointMs: 30_000 });
    fake.hear("buy milk", true);
    // The recognizer ends on its own again and again while nothing is said.
    for (let ended = 0; ended < 8; ended += 1) {
      fake.end();
      vi.advanceTimersByTime(RESTART_CAP_MS);
    }
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(onFinal).toHaveBeenCalledWith("buy milk");
  });

  it("keeps listening through pauses shorter than its endpoint until finished", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, endpointMs: 30_000 });
    fake.hear("buy milk", true);
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS * 5);
    fake.hear("and eggs");
    expect(onFinal).not.toHaveBeenCalled();
    finishListening();
    expect(onFinal).toHaveBeenCalledWith("buy milk and eggs");
    expect(fake.abort).toHaveBeenCalled();
  });

  it("keeps the call's current audio session only when a call is listening", async () => {
    await listen({ onFinal: vi.fn(), call: true });
    expect(fake.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ iosCategory: CALL_SESSION }),
    );
  });

  it("reports the microphone's loudness from 0 to 1 only to a caller that follows it", async () => {
    await listen({ onFinal: vi.fn() });
    expect(fake.start.mock.lastCall?.[0].volumeChangeEventOptions).toBeUndefined();
    const onLevel = vi.fn();
    await listen({ onFinal: vi.fn(), onLevel });
    expect(fake.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        volumeChangeEventOptions: expect.objectContaining({ enabled: true }),
      }),
    );
    for (const value of [-2, 5, 12]) fake.volume(value);
    expect(onLevel.mock.calls).toEqual([[0], [0.5], [1]]);
  });

  it("ends the turn only after the silence window, not on the recognizer's own final", async () => {
    const onFinal = vi.fn();
    const interims: string[] = [];
    await listen({ onFinal, onInterim: (text) => interims.push(text) });
    expect(fake.start).toHaveBeenCalledWith({
      lang: "en-US",
      interimResults: true,
      continuous: true,
    });

    fake.hear("how is the");
    fake.hear("how is the", true);
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS - 400);
    expect(onFinal).not.toHaveBeenCalled();

    fake.hear("deploy going");
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS - 1);
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("how is the deploy going");
    expect(interims).toEqual(["how is the", "how is the", "how is the deploy going"]);
  });

  it("ends the turn a short grace after the recognizer reports the end of speech and its final", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, call: true });
    fake.hear("how is the");
    fake.speechEnd();
    // The recognizer is still catching up on the same phrase.
    fake.hear("how is the deploy going");
    vi.advanceTimersByTime(FINAL_AFTER_SPEECH_END_MS);
    fake.hear("how is the deploy going", true);
    vi.advanceTimersByTime(END_OF_SPEECH_GRACE_MS - 1);
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFinal).toHaveBeenCalledExactlyOnceWith("how is the deploy going");
    expect(fake.abort).toHaveBeenCalled();
  });

  it("ends the turn a short grace after an end of speech that follows the final", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, call: true });
    fake.hear("status please", true);
    vi.advanceTimersByTime(100);
    fake.speechEnd();
    vi.advanceTimersByTime(END_OF_SPEECH_GRACE_MS - 1);
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFinal).toHaveBeenCalledExactlyOnceWith("status please");
  });

  it("waits the full silence window when the caller keeps talking after the final", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, call: true });
    fake.hear("buy milk");
    fake.speechEnd();
    fake.hear("buy milk", true);
    vi.advanceTimersByTime(300);
    fake.hear("and");
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS - 1);
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFinal).toHaveBeenCalledExactlyOnceWith("buy milk and");
  });

  it("waits the full silence window when a new phrase arrives straight as a final", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, call: true });
    fake.speechEnd();
    fake.hear("buy milk", true);
    vi.advanceTimersByTime(300);
    fake.hear("and eggs", true);
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS - 1);
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFinal).toHaveBeenCalledExactlyOnceWith("buy milk and eggs");
  });

  it("waits the full silence window when the recognizer hears speech start again", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, call: true });
    fake.hear("buy milk");
    fake.speechEnd();
    fake.hear("buy milk", true);
    vi.advanceTimersByTime(300);
    fake.speechStart();
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS - 300 - 1);
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFinal).toHaveBeenCalledExactlyOnceWith("buy milk");
  });

  it("shortens the gap again once the next phrase also ends", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, call: true });
    fake.speechEnd();
    fake.hear("buy milk", true);
    vi.advanceTimersByTime(300);
    fake.hear("and eggs");
    // A final alone, the recognizer's breath boundary, is not enough.
    fake.hear("and eggs", true);
    vi.advanceTimersByTime(END_OF_SPEECH_GRACE_MS);
    expect(onFinal).not.toHaveBeenCalled();
    fake.speechEnd();
    vi.advanceTimersByTime(END_OF_SPEECH_GRACE_MS - 1);
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFinal).toHaveBeenCalledExactlyOnceWith("buy milk and eggs");
  });

  it.each([
    ["only a final", () => fake.hear("status please", true)],
    [
      "only the end of speech",
      () => {
        fake.hear("status please");
        fake.speechEnd();
      },
    ],
    [
      "both, then the recognizer ends",
      () => {
        fake.speechEnd();
        fake.hear("status please", true);
        fake.end();
      },
    ],
  ])("keeps the full silence window when the recognizer reports %s", async (_case, report) => {
    const onFinal = vi.fn();
    await listen({ onFinal, call: true });
    report();
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS - 1);
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFinal).toHaveBeenCalledExactlyOnceWith("status please");
  });

  it("never shortens a pause limit the caller chose", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, endpointMs: 30_000 });
    fake.hear("buy");
    fake.speechEnd();
    fake.hear("buy milk", true);
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS * 5);
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("restarts a session that reports nothing for too long", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal });
    vi.advanceTimersByTime(QUIET_RESTART_MS - 1);
    expect(fake.abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fake.abort).toHaveBeenCalledOnce();

    fake.end();
    vi.advanceTimersByTime(250);
    expect(fake.start).toHaveBeenCalledTimes(2);
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("restarts a quiet session that keeps reporting empty results", async () => {
    await listen({ onFinal: vi.fn() });
    for (let elapsed = 0; elapsed < QUIET_RESTART_MS; elapsed += 5_000) {
      vi.advanceTimersByTime(5_000);
      fake.hear("");
    }
    expect(fake.abort).toHaveBeenCalledOnce();
  });

  it("keeps a session that is hearing the caller", async () => {
    await listen({ onFinal: vi.fn() });
    vi.advanceTimersByTime(QUIET_RESTART_MS - 100);
    fake.hear("still there");
    vi.advanceTimersByTime(100);
    expect(fake.abort).not.toHaveBeenCalled();
  });

  it("restarts a session that ended mid-turn and carries the words already heard", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal });
    fake.hear("hello there");

    fake.end();
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(fake.start).toHaveBeenCalledTimes(2);

    fake.hear("friend");
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS);
    expect(onFinal).toHaveBeenCalledWith("hello there friend");
  });

  it("gives up after restarts that hear nothing", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal });
    fake.hear("half a sentence");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      fake.end();
      vi.advanceTimersByTime(RESTART_CAP_MS);
    }
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenCalledWith("half a sentence");
  });

  it("notifies the caller when empty restarts give up", async () => {
    const onFinal = vi.fn();
    const onGiveUp = vi.fn();
    await listen({ onFinal, onGiveUp });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      fake.end();
      vi.advanceTimersByTime(RESTART_CAP_MS);
    }
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("idle");
    expect(reportMobileError).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
    expect(fake.abort).toHaveBeenCalled();
    fake.end();
    expect(onGiveUp).toHaveBeenCalledOnce();
  });

  it.each([
    "not-allowed",
    "service-not-allowed",
    "audio-capture",
    "language-not-supported",
    "bad-grammar",
  ])("notifies the caller when recognition fails with %s", async (error) => {
    const onFinal = vi.fn();
    const onGiveUp = vi.fn();
    await listen({ onFinal, onGiveUp });
    fake.fail(error);
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("failed");
    expect(reportMobileError).toHaveBeenCalledExactlyOnceWith(
      new Error(`Speech recognition stopped: ${error}`),
      "voice.microphone",
      { source: "dictation" },
    );
    expect(onFinal).not.toHaveBeenCalled();
    fake.end();
    vi.advanceTimersByTime(RESTART_CAP_MS);
    expect(fake.start).toHaveBeenCalledOnce();
  });

  it.each(["no-speech", "speech-timeout", "interrupted", "aborted"])(
    "restarts after routine %s without disabling recognition",
    async (error) => {
      const onGiveUp = vi.fn();
      await listen({ onFinal: vi.fn(), onGiveUp });
      fake.fail(error);
      fake.end();
      vi.advanceTimersByTime(250);
      expect(fake.start).toHaveBeenCalledTimes(2);
      expect(onGiveUp).not.toHaveBeenCalled();
    },
  );

  it.each(["client", "busy", "network", "unknown", "too-many-requests"])(
    "delivers a turn after a transient %s error and restart",
    async (error) => {
      const onFinal = vi.fn();
      const onGiveUp = vi.fn();
      await listen({ onFinal, onGiveUp });
      fake.fail(error);
      fake.end();
      vi.advanceTimersByTime(250);
      expect(fake.start).toHaveBeenCalledTimes(2);
      fake.hear("status please");
      vi.advanceTimersByTime(ENDPOINT_SILENCE_MS);
      expect(onFinal).toHaveBeenCalledExactlyOnceWith("status please");
      expect(onGiveUp).not.toHaveBeenCalled();
      expect(reportMobileError).not.toHaveBeenCalled();
    },
  );

  it.each(["network", "client", "busy", "unknown", "too-many-requests"])(
    "fails after empty restarts ending in transient %s errors",
    async (error) => {
      const onFinal = vi.fn();
      const onGiveUp = vi.fn();
      await listen({ onFinal, onGiveUp });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        fake.fail(error);
        expect(onGiveUp).not.toHaveBeenCalled();
        fake.end();
        vi.advanceTimersByTime(RESTART_CAP_MS);
      }
      expect(fake.start).toHaveBeenCalledTimes(6);
      expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("failed");
      expect(onFinal).not.toHaveBeenCalled();
      expect(reportMobileError).toHaveBeenCalledExactlyOnceWith(
        new Error("Speech recognition stopped: transient-restarts"),
        "voice.microphone",
        { source: "dictation" },
      );
    },
  );

  it.each(["no-speech", "speech-timeout"])(
    "stays idle after empty %s restarts even after an earlier transient error",
    async (error) => {
      const onGiveUp = vi.fn();
      await listen({ onFinal: vi.fn(), onGiveUp });
      fake.fail("network");
      fake.end();
      vi.advanceTimersByTime(RESTART_CAP_MS);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        fake.fail(error);
        fake.end();
        vi.advanceTimersByTime(RESTART_CAP_MS);
      }
      expect(fake.start).toHaveBeenCalledTimes(6);
      expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("idle");
      expect(reportMobileError).not.toHaveBeenCalled();
    },
  );

  it("notifies the caller when start throws on restart", async () => {
    const onFinal = vi.fn();
    const onGiveUp = vi.fn();
    await listen({ onFinal, onGiveUp });
    fake.start.mockImplementationOnce(() => {
      throw new Error("recognizer unavailable");
    });
    fake.end();
    vi.advanceTimersByTime(RESTART_CAP_MS);
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("failed");
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("never starts the recognizer when the signal aborts during loading", async () => {
    const onFinal = vi.fn();
    const controller = new AbortController();
    const listening = listen({ onFinal, signal: controller.signal });
    controller.abort();
    await listening;

    expect(fake.start).not.toHaveBeenCalled();
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("never finalizes an aborted session", async () => {
    const onFinal = vi.fn();
    const controller = new AbortController();
    await listen({ onFinal, signal: controller.signal });
    fake.hear("cancel this");

    controller.abort();
    expect(fake.abort).toHaveBeenCalled();
    fake.hear("and this", true);
    fake.end();
    vi.advanceTimersByTime(10_000);

    expect(onFinal).not.toHaveBeenCalled();
  });

  it("leaves a newer session running when a cancelled request arrives late", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal, signal: new AbortController().signal });
    const cancelled = new AbortController();
    cancelled.abort();

    await listen({ onFinal: vi.fn(), signal: cancelled.signal });
    expect(fake.abort).not.toHaveBeenCalled();
    fake.hear("still here");
    vi.advanceTimersByTime(ENDPOINT_SILENCE_MS);

    expect(fake.start).toHaveBeenCalledOnce();
    expect(onFinal).toHaveBeenCalledWith("still here");
  });

  it("ends the turn on a permission error instead of hanging on the mic", async () => {
    const onFinal = vi.fn();
    await listen({ onFinal });
    fake.hear("open the door");
    fake.fail("not-allowed");
    expect(onFinal).toHaveBeenCalledWith("open the door");
    expect(reportMobileError).toHaveBeenCalledExactlyOnceWith(
      new Error("Speech recognition stopped: not-allowed"),
      "voice.microphone",
      { source: "dictation" },
    );
  });
});
