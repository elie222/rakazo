// @vitest-environment jsdom

import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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

vi.mock("./api", () => ({
  captureApiRequestContext: vi.fn(async () => ({
    apiBase: "https://api.test",
    sessionGeneration: 1,
    headers: {},
  })),
  rpc: vi.fn(),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./voice", () => ({ ensureVoiceConsent: vi.fn(async () => undefined) }));
vi.mock("./call-session", () => ({
  recordClip: voice.recordClip,
  transcribeClip: voice.transcribeClip,
}));
vi.mock("./device-voice", () => ({ loadDeviceVoiceEnabled: vi.fn(async () => false) }));
vi.mock("./dictation", () => ({
  available: vi.fn(async () => false),
  listen: vi.fn(),
  finishListening: vi.fn(),
}));
vi.mock("./i18n", () => ({
  deviceLanguage: vi.fn(async () => "en"),
  getActiveUiLocale: () => "en",
}));
vi.mock("./user-error", () => ({ errorText: (_error: unknown, fallback: string) => fallback }));
vi.mock("./voice-call-entry", () => ({
  resolveVoiceCallPlan: vi.fn(async () => ({ kind: "provider", transcribe: true })),
}));

import { useComposerDictation } from "./composer-dictation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;
let words: Array<{ text: string; final?: boolean }>;
let toggle: () => void;
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

it("drops a transcription when the composer unmounts", async () => {
  const pending = await stopDuringTranscription();
  act(() => root.unmount());
  mounted = false;
  await finishTranscription(pending, "the latest report");
  expect(words).toEqual([]);
});
