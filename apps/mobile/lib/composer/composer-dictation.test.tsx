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
  recordAudio: vi.fn(),
  deleteQuietly: vi.fn(),
  transcribeClip: vi.fn(),
  appleTranscriber: vi.fn(
    async (
      _lang: string,
      _onPreparing: () => void,
    ): Promise<((uri: string) => Promise<string>) | null> => null,
  ),
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
  recordAudio: voice.recordAudio,
  deleteQuietly: voice.deleteQuietly,
  transcribeClip: voice.transcribeClip,
}));
vi.mock("../voice/apple-transcription", () => ({ appleTranscriber: voice.appleTranscriber }));
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

it("records until the second tap, then transcribes on the phone in one pass", async () => {
  const { resolveVoiceCallPlan } = await import("../calls/voice-call-entry");
  const dictation = await import("../voice/dictation");
  vi.mocked(resolveVoiceCallPlan).mockResolvedValueOnce({ kind: "device", transcribe: false });
  const transcribe = vi.fn(async () => "Pick up milk, then call Sam.");
  const prepared = deferred<typeof transcribe>();
  voice.appleTranscriber.mockImplementationOnce(async (_lang, onPreparing) => {
    onPreparing();
    return prepared.promise;
  });
  voice.recordAudio.mockImplementationOnce(async (_cancel: AbortSignal, until: AbortSignal) => {
    await new Promise<void>((resolve) => until.addEventListener("abort", () => resolve()));
    return { uri: "file:///clip.m4a", mimeType: "audio/m4a" };
  });
  await act(async () => toggle());
  // The first use downloads the language's model, and the mic shows it preparing until ready.
  await vi.waitFor(() => expect(container.textContent).toBe("preparing"));
  expect(voice.recordAudio).not.toHaveBeenCalled();
  await act(async () => prepared.resolve(transcribe));
  await vi.waitFor(() => expect(voice.recordAudio).toHaveBeenCalled());
  expect(container.textContent).toBe("listening");
  await act(async () => toggle());
  await vi.waitFor(() =>
    expect(words).toEqual([{ text: "Pick up milk, then call Sam.", final: true }]),
  );
  expect(transcribe).toHaveBeenCalledWith("file:///clip.m4a");
  expect(voice.deleteQuietly).toHaveBeenCalledWith("file:///clip.m4a");
  expect(dictation.listen).not.toHaveBeenCalled();
});

it("dictates on the phone without asking for live speech recognition", async () => {
  const { resolveVoiceCallPlan } = await import("../calls/voice-call-entry");
  const dictation = await import("../voice/dictation");
  voice.appleTranscriber.mockResolvedValueOnce(vi.fn(async () => ""));
  await act(async () => toggle());
  await vi.waitFor(() => expect(resolveVoiceCallPlan).toHaveBeenCalled());
  const deps = vi.mocked(resolveVoiceCallPlan).mock.calls[0]?.[0];
  expect(await deps?.dictationAvailable()).toBe(true);
  expect(dictation.available).not.toHaveBeenCalled();
});

it("drops a session cancelled while the model prepares without asking for speech", async () => {
  const { resolveVoiceCallPlan } = await import("../calls/voice-call-entry");
  const dictation = await import("../voice/dictation");
  const prepared = deferred<null>();
  voice.appleTranscriber.mockImplementationOnce(async (_lang, onPreparing) => {
    onPreparing();
    return prepared.promise;
  });
  await act(async () => toggle());
  await vi.waitFor(() => expect(resolveVoiceCallPlan).toHaveBeenCalled());
  const available = vi.mocked(resolveVoiceCallPlan).mock.calls[0]?.[0].dictationAvailable();
  await vi.waitFor(() => expect(container.textContent).toBe("preparing"));
  await act(async () => app.blur?.());
  await act(async () => prepared.resolve(null));
  expect(await available).toBe(false);
  expect(dictation.available).not.toHaveBeenCalled();
  expect(container.textContent).toBe("idle");
});

it("cancels on a tap while the model prepares", async () => {
  const { resolveVoiceCallPlan } = await import("../calls/voice-call-entry");
  vi.mocked(resolveVoiceCallPlan).mockResolvedValueOnce({ kind: "device", transcribe: false });
  const prepared = deferred<null>();
  voice.appleTranscriber.mockImplementationOnce(async (_lang, onPreparing) => {
    onPreparing();
    return prepared.promise;
  });
  await act(async () => toggle());
  await vi.waitFor(() => expect(container.textContent).toBe("preparing"));
  await act(async () => toggle());
  expect(container.textContent).toBe("idle");
  await act(async () => prepared.resolve(null));
  expect(container.textContent).toBe("idle");
  expect(voice.recordAudio).not.toHaveBeenCalled();
});
