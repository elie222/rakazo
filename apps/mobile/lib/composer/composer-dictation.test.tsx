// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import { AudioModule } from "expo-audio";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureVoiceConsent } from "../voice/voice";

const app = vi.hoisted(() => ({
  appState: new Set<(state: string) => void>(),
  blur: undefined as undefined | (() => void),
}));

const voice = vi.hoisted(() => ({
  recordClip: vi.fn(),
  transcribeClip: vi.fn(),
}));

vi.mock("expo-router", () => ({
  useNavigation: () => ({
    addListener: (event: string, listener: () => void) => {
      if (event === "blur") app.blur = listener;
      return () => {
        if (event === "blur" && app.blur === listener) app.blur = undefined;
      };
    },
  }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      app.appState.add(listener);
      return { remove: () => app.appState.delete(listener) };
    },
  },
}));

vi.mock("expo-audio", () => ({
  AudioModule: {
    requestRecordingPermissionsAsync: vi.fn(async () => ({ granted: true })),
  },
}));

vi.mock("../api/api", () => ({
  captureApiRequestContext: vi.fn(async () => ({
    apiBase: "https://api.test",
    sessionGeneration: 1,
    headers: {},
  })),
  rpc: vi.fn(),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../voice/voice", () => ({ ensureVoiceConsent: vi.fn(async () => undefined) }));
vi.mock("../calls/call-session", () => ({
  recordClip: voice.recordClip,
  transcribeClip: voice.transcribeClip,
}));
vi.mock("../voice/device-voice", () => ({ loadDeviceVoiceEnabled: vi.fn(async () => false) }));
vi.mock("../voice/dictation", () => ({
  available: vi.fn(async () => false),
  listen: vi.fn(),
  finishListening: vi.fn(),
}));
vi.mock("../i18n/i18n", () => ({
  deviceLanguage: vi.fn(async () => "en"),
  getActiveUiLocale: () => "en",
}));
vi.mock("../api/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("../calls/voice-call-entry", () => ({
  resolveVoiceCallPlan: vi.fn(async () => ({ kind: "provider", transcribe: true })),
}));

import { useComposerDictation } from "./composer-dictation";

let root: Root;
let container: HTMLDivElement;
let words: Array<{ text: string; final?: boolean }>;
let toggle: () => void;
let finish: (then: () => void) => void;
let cancel: () => void;
let mounted = false;

function Harness() {
  const [, redraw] = useState(0);
  const dictation = useComposerDictation({
    disabled: false,
    onWords: (text, final) => {
      words.push({ text, final });
      redraw((n) => n + 1);
    },
  });
  toggle = dictation.toggle;
  finish = dictation.finish;
  cancel = dictation.cancel;
  return (
    <button type="button" onClick={() => dictation.toggle()}>
      {dictation.status}
    </button>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  app.appState.clear();
  app.blur = undefined;
  words = [];
  voice.recordClip.mockImplementation(async (_cancel: AbortSignal, until: AbortSignal) => {
    if (!until.aborted) {
      await new Promise<void>((resolve) => {
        until.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return { base64: "clip", mimeType: "audio/m4a" };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mounted = true;
  act(() => root.render(<Harness />));
});

afterEach(() => {
  if (mounted) act(() => root.unmount());
  mounted = false;
  container.remove();
  vi.unstubAllGlobals();
});

/** Start a provider dictation and tap Stop, leaving the transcription in flight. */
async function stopDuringTranscription() {
  const pending = deferred<string>();
  voice.transcribeClip.mockReturnValueOnce(pending.promise);
  await act(async () => {
    toggle();
  });
  await vi.waitFor(() => expect(voice.recordClip).toHaveBeenCalled());
  await act(async () => {
    toggle();
  });
  await vi.waitFor(() => expect(voice.transcribeClip).toHaveBeenCalled());
  return pending;
}

async function finishTranscription(pending: ReturnType<typeof deferred<string>>, text: string) {
  await act(async () => {
    pending.resolve(text);
    await pending.promise;
  });
}

it("lands dictated words when the app goes to the background during transcription", async () => {
  const pending = await stopDuringTranscription();
  act(() => {
    for (const listener of app.appState) listener("background");
  });
  await finishTranscription(pending, "the latest report");
  expect(words).toEqual([{ text: "the latest report", final: true }]);
});

it("lands dictated words when the chat blurs during transcription", async () => {
  const pending = await stopDuringTranscription();
  act(() => app.blur?.());
  await finishTranscription(pending, "the latest report");
  expect(words).toEqual([{ text: "the latest report", final: true }]);
});

it("runs what waits on a finished dictation after its words land", async () => {
  const pending = deferred<string>();
  voice.transcribeClip.mockReturnValueOnce(pending.promise);
  await act(async () => toggle());
  await vi.waitFor(() => expect(voice.recordClip).toHaveBeenCalled());
  const then = vi.fn(() => expect(words).toEqual([{ text: "send it", final: true }]));
  await act(async () => finish(then));
  await vi.waitFor(() => expect(voice.transcribeClip).toHaveBeenCalled());
  expect(then).not.toHaveBeenCalled();
  await finishTranscription(pending, "send it");
  expect(then).toHaveBeenCalledTimes(1);
});

it("runs what waits on a dictation finished before the mic opens, and stops the setup", async () => {
  const consent = deferred<void>();
  vi.mocked(ensureVoiceConsent).mockReturnValueOnce(consent.promise);
  await act(async () => toggle());
  await vi.waitFor(() => expect(ensureVoiceConsent).toHaveBeenCalled());
  const then = vi.fn();
  act(() => finish(then));
  expect(then).toHaveBeenCalledTimes(1);
  await act(async () => {
    consent.resolve();
    await consent.promise;
  });
  expect(voice.recordClip).not.toHaveBeenCalled();
});

it("never runs what waits on a dictation that is cancelled", async () => {
  const pending = deferred<string>();
  voice.transcribeClip.mockReturnValueOnce(pending.promise);
  await act(async () => toggle());
  await vi.waitFor(() => expect(voice.recordClip).toHaveBeenCalled());
  const then = vi.fn();
  await act(async () => finish(then));
  await vi.waitFor(() => expect(voice.transcribeClip).toHaveBeenCalled());
  act(() => cancel());
  await finishTranscription(pending, "send it");
  expect(then).not.toHaveBeenCalled();
  expect(words).toEqual([]);
});

it("drops a transcription when the composer unmounts", async () => {
  const pending = await stopDuringTranscription();
  act(() => root.unmount());
  mounted = false;
  await finishTranscription(pending, "the latest report");
  expect(words).toEqual([]);
});

it.each(["blur", "unmount"])(
  "does not request microphone permission after %s during consent",
  async (cancel) => {
    const consent = deferred<void>();
    vi.mocked(ensureVoiceConsent).mockReturnValueOnce(consent.promise);
    await act(async () => toggle());
    await vi.waitFor(() => expect(ensureVoiceConsent).toHaveBeenCalled());
    act(() => {
      if (cancel === "blur") app.blur?.();
      else {
        root.unmount();
        mounted = false;
      }
    });
    await act(async () => {
      consent.resolve();
      await consent.promise;
    });
    expect(AudioModule.requestRecordingPermissionsAsync).not.toHaveBeenCalled();
    expect(voice.recordClip).not.toHaveBeenCalled();
  },
);
