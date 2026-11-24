// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
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
  microphonePermission: vi.fn(async () => ({ granted: true })),
  recordClip: vi.fn(),
  recordAudio: vi.fn(),
  deleteQuietly: vi.fn(),
  transcribeClip: vi.fn(),
  appleTranscriber: vi.fn(
    async (_lang: string): Promise<((uri: string) => Promise<string>) | null> => null,
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

vi.mock("react-native-reanimated", async () => {
  const { useState } = await import("react");
  return { useSharedValue: <T,>(initial: T) => useState(() => ({ value: initial }))[0] };
});
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
vi.mock("../voice/voice-clip", () => ({
  microphonePermission: voice.microphonePermission,
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
let words: string[];
let toggle: () => void;
let mounted = false;

function Harness() {
  const [, redraw] = useState(0);
  const dictation = useComposerDictation({
    disabled: false,
    onWords: (text) => {
      words.push(text);
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
  voice.recordClip.mockImplementation(
    async (_cancel: AbortSignal, until: AbortSignal, options?: { onRecording?: () => void }) => {
      options?.onRecording?.();
      if (!until.aborted) {
        await new Promise<void>((resolve) => {
          until.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return { base64: "clip", mimeType: "audio/m4a" };
    },
  );
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
  expect(words).toEqual(["the latest report"]);
});

it("lands dictated words when the chat blurs during transcription", async () => {
  const pending = await stopDuringTranscription();
  act(() => app.blur?.());
  await finishTranscription(pending, "the latest report");
  expect(words).toEqual(["the latest report"]);
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
    expect(voice.microphonePermission).not.toHaveBeenCalled();
    expect(voice.recordClip).not.toHaveBeenCalled();
  },
);

it("records until the second tap, then transcribes on the phone in one pass", async () => {
  const dictation = await import("../voice/dictation");
  const transcribe = vi.fn(async () => "Pick up milk, then call Sam.");
  const prepared = deferred<typeof transcribe>();
  voice.appleTranscriber.mockImplementationOnce(() => prepared.promise);
  voice.recordAudio.mockImplementationOnce(
    async (_cancel: AbortSignal, until: AbortSignal, options?: { onRecording?: () => void }) => {
      options?.onRecording?.();
      await new Promise<void>((resolve) => until.addEventListener("abort", () => resolve()));
      return { uri: "file:///clip.m4a", mimeType: "audio/m4a" };
    },
  );
  await act(async () => toggle());
  // The first use downloads the language's model, and the mic shows it preparing until ready.
  await vi.waitFor(() => expect(container.textContent).toBe("preparing"));
  expect(voice.recordAudio).not.toHaveBeenCalled();
  await act(async () => prepared.resolve(transcribe));
  await vi.waitFor(() => expect(voice.recordAudio).toHaveBeenCalled());
  expect(container.textContent).toBe("listening");
  await act(async () => toggle());
  await vi.waitFor(() => expect(words).toEqual(["Pick up milk, then call Sam."]));
  expect(transcribe).toHaveBeenCalledWith("file:///clip.m4a", []);
  expect(voice.deleteQuietly).toHaveBeenCalledWith("file:///clip.m4a");
  expect(dictation.listen).not.toHaveBeenCalled();
});

it("dictates on the phone at full quality with taught words, even when a hosted voice reads replies", async () => {
  const { resolveVoiceCallPlan } = await import("../calls/voice-call-entry");
  const dictation = await import("../voice/dictation");
  const { rpc } = await import("../api/api");
  vi.mocked(rpc).mockResolvedValueOnce({ words: ["Rakazo", "gh-dash"] });
  // The default mocks: device voice off, a provider that transcribes.
  const transcribe = vi.fn(async () => "Ship it on Thursday.");
  voice.appleTranscriber.mockResolvedValueOnce(transcribe);
  voice.recordAudio.mockImplementationOnce(
    async (_cancel: AbortSignal, until: AbortSignal, options?: { onRecording?: () => void }) => {
      options?.onRecording?.();
      await new Promise<void>((resolve) => until.addEventListener("abort", () => resolve()));
      return { uri: "file:///clip.m4a", mimeType: "audio/m4a" };
    },
  );
  await act(async () => toggle());
  await vi.waitFor(() => expect(voice.recordAudio).toHaveBeenCalled());
  expect(voice.recordAudio.mock.calls[0]?.[2]).toMatchObject({ onDevice: true });
  await act(async () => toggle());
  await vi.waitFor(() => expect(words).toEqual(["Ship it on Thursday."]));
  // The phone listens for the names the server knows this person uses.
  expect(rpc).toHaveBeenCalledWith("voice/words", undefined, expect.anything());
  expect(transcribe).toHaveBeenCalledWith("file:///clip.m4a", ["Rakazo", "gh-dash"]);
  expect(resolveVoiceCallPlan).not.toHaveBeenCalled();
  expect(voice.recordClip).not.toHaveBeenCalled();
  expect(dictation.available).not.toHaveBeenCalled();
});

it("drops a session cancelled while the model prepares", async () => {
  const { resolveVoiceCallPlan } = await import("../calls/voice-call-entry");
  const prepared = deferred<null>();
  voice.appleTranscriber.mockImplementationOnce(() => prepared.promise);
  await act(async () => toggle());
  await vi.waitFor(() => expect(container.textContent).toBe("preparing"));
  await act(async () => app.blur?.());
  await act(async () => prepared.resolve(null));
  expect(container.textContent).toBe("idle");
  expect(resolveVoiceCallPlan).not.toHaveBeenCalled();
  expect(voice.recordAudio).not.toHaveBeenCalled();
});

it("cancels on a tap while the model prepares", async () => {
  const prepared = deferred<null>();
  voice.appleTranscriber.mockImplementationOnce(() => prepared.promise);
  await act(async () => toggle());
  await vi.waitFor(() => expect(container.textContent).toBe("preparing"));
  await act(async () => toggle());
  expect(container.textContent).toBe("idle");
  await act(async () => prepared.resolve(null));
  expect(container.textContent).toBe("idle");
  expect(voice.recordAudio).not.toHaveBeenCalled();
});

it("shows preparing until a fallback's microphone opens, then listening", async () => {
  const { resolveVoiceCallPlan } = await import("../calls/voice-call-entry");
  const plan = deferred<{ kind: "provider"; transcribe: true }>();
  vi.mocked(resolveVoiceCallPlan).mockReturnValueOnce(plan.promise);
  await act(async () => toggle());
  expect(container.textContent).toBe("preparing");
  await act(async () => plan.resolve({ kind: "provider", transcribe: true }));
  await vi.waitFor(() => expect(voice.recordClip).toHaveBeenCalled());
  expect(container.textContent).toBe("listening");
});

it("starts the timer only once the recorder captures, after any permission prompt", async () => {
  const permission = deferred<void>();
  voice.appleTranscriber.mockResolvedValueOnce(vi.fn(async () => ""));
  voice.recordAudio.mockImplementationOnce(
    async (_cancel: AbortSignal, until: AbortSignal, options?: { onRecording?: () => void }) => {
      await permission.promise;
      options?.onRecording?.();
      await new Promise<void>((resolve) => until.addEventListener("abort", () => resolve()));
      return null;
    },
  );
  await act(async () => toggle());
  await vi.waitFor(() => expect(voice.recordAudio).toHaveBeenCalled());
  expect(container.textContent).toBe("preparing");
  await act(async () => permission.resolve());
  expect(container.textContent).toBe("listening");
});
