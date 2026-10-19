// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const voice = vi.hoisted(() => ({
  catalog: vi.fn(),
  credentials: vi.fn(),
  status: vi.fn(),
  voices: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  setVoice: vi.fn(),
  setSpeechModel: vi.fn(),
}));

const { speak } = vi.hoisted(() => ({ speak: vi.fn(async () => undefined) }));
vi.mock("../lib/tts.js", () => ({ speaker: { speak, state: {} } }));
vi.mock("../lib/rpc", () => ({ rpc: { voice }, rpcForSpace: () => ({ voice }) }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Dialog: Container,
    DialogClose: Container,
    DialogContent: Container,
    DialogTitle: Container,
    Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    FieldLabel: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { SpaceRpcProvider } from "../lib/space-rpc";
import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

const fish = {
  id: "cred-fish",
  provider: "fish-audio",
  hasKey: true,
  isDefault: true,
  voiceId: "voice-1",
  speechModel: "",
  transcribe: true,
};
const eleven = {
  id: "cred-eleven",
  provider: "elevenlabs",
  hasKey: true,
  isDefault: false,
  voiceId: "rachel",
  speechModel: "",
  transcribe: true,
};

function speechModelInput(container: HTMLElement): HTMLInputElement | undefined {
  return [...container.querySelectorAll("input")].find((input) => {
    const label = container.querySelector(`label[for="${input.id}"]`);
    return label?.textContent === "Speech model";
  });
}

it("saves a Fish speech model on the existing provider pane", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voice.catalog.mockResolvedValue([
    { id: "fish-audio", name: "Fish Audio", description: "", transcribe: true },
    { id: "elevenlabs", name: "ElevenLabs", description: "", transcribe: true },
  ]);
  voice.credentials.mockResolvedValue([fish, eleven]);
  voice.status.mockResolvedValue({
    configured: true,
    ready: true,
    transcribe: true,
    provider: "fish-audio",
    voiceId: "voice-1",
  });
  voice.voices.mockImplementation(async ({ provider }: { provider?: string }) =>
    provider === "elevenlabs"
      ? [{ id: "rachel", label: "Rachel" }]
      : [{ id: "voice-1", label: "Aria" }],
  );
  voice.setSpeechModel.mockImplementation(async ({ speechModel }: { speechModel: string }) => ({
    ...fish,
    speechModel,
  }));

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes(text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  try {
    await act(async () => {
      root.render(<VoiceSettingsOverlay embedded onClose={() => undefined} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const input = speechModelInput(container);
    expect(input).toBeTruthy();
    expect(input?.placeholder).toBe("Optional");

    await act(async () => {
      button("ElevenLabs").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(speechModelInput(container)).toBeUndefined();

    await act(async () => {
      button("Fish Audio").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const fishInput = speechModelInput(container);
    if (!fishInput) throw new Error("Missing speech model field");
    await act(async () => {
      fishInput.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(fishInput, "s1");
      fishInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      fishInput.blur();
    });

    expect(voice.setSpeechModel).toHaveBeenCalledWith({
      provider: "fish-audio",
      speechModel: "s1",
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

function labelledInput(container: HTMLElement, text: string): HTMLInputElement {
  const found = [...container.querySelectorAll("input")].find(
    (input) => container.querySelector(`label[for="${input.id}"]`)?.textContent === text,
  );
  if (!found) throw new Error(`Missing field: ${text}`);
  return found;
}

it("connects a self-hosted speech server by URL without a key", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voice.connect.mockReset();
  voice.catalog.mockResolvedValue([
    { id: "openai-compatible", name: "Self-hosted", description: "", transcribe: true },
  ]);
  voice.credentials.mockResolvedValue([]);
  voice.status.mockResolvedValue({
    configured: false,
    ready: false,
    transcribe: false,
    provider: null,
    voiceId: "",
  });
  voice.connect.mockResolvedValue({
    id: "cred-local",
    provider: "openai-compatible",
    hasKey: true,
    isDefault: true,
    voiceId: "af_heart",
    speechModel: "",
    transcribe: true,
    endpoint: "http://100.64.0.10:8810/v1",
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const connect = () =>
    [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Connect");
  try {
    await act(async () => {
      root.render(<VoiceSettingsOverlay embedded onClose={() => undefined} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(labelledInput(container, "API key").placeholder).toBe("Optional");
    expect(labelledInput(container, "Speech model").placeholder).toBe(
      "mlx-community/Kokoro-82M-bf16",
    );
    expect(connect()?.disabled).toBe(true);

    await type(labelledInput(container, "Server URL"), " http://100.64.0.10:8810 ");
    expect(connect()?.disabled).toBe(false);
    await act(async () => {
      connect()?.click();
    });

    expect(voice.connect).toHaveBeenCalledWith({
      provider: "openai-compatible",
      apiKey: "",
      voiceId: undefined,
      baseUrl: "http://100.64.0.10:8810",
      ttsModel: undefined,
      sttModel: undefined,
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([
  { field: "Server URL", value: "http://100.64.0.11:8880/v1" },
  { field: "Speech model", value: "new-model" },
  { field: "Transcription model", value: "new-transcriber" },
  { field: "API key", value: "replacement-test-key" },
])(
  "restores saved self-hosted fields and reconnects after editing $field",
  async ({ field, value }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    voice.connect.mockReset();
    const saved = {
      ...fish,
      provider: "openai-compatible",
      endpoint: "http://100.64.0.10:8810/v1",
      ttsModel: "saved-speech",
      sttModel: "saved-transcription",
    };
    voice.catalog.mockResolvedValue([
      { id: saved.provider, name: "Self-hosted", description: "", transcribe: true },
    ]);
    voice.credentials.mockResolvedValue([saved]);
    voice.status.mockResolvedValue({
      configured: true,
      ready: true,
      provider: saved.provider,
      voiceId: saved.voiceId,
    });
    voice.voices.mockResolvedValue([{ id: saved.voiceId, label: "Saved voice" }]);
    voice.connect.mockResolvedValue(saved);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<VoiceSettingsOverlay embedded onClose={() => undefined} />);
      });
      expect(labelledInput(container, "Server URL").value).toBe(saved.endpoint);
      expect(labelledInput(container, "Speech model").value).toBe(saved.ttsModel);
      expect(labelledInput(container, "Transcription model").value).toBe(saved.sttModel);
      expect(labelledInput(container, "API key").value).toBe("");
      await act(async () => {
        const input = labelledInput(container, field);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Reconnect")
          ?.click();
      });
      expect(voice.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: saved.provider,
          // The API decides whether a new server or model invalidates this voice.
          voiceId: saved.voiceId,
          baseUrl: field === "Server URL" ? value : saved.endpoint,
          ttsModel: field === "Speech model" ? value : saved.ttsModel,
          sttModel: field === "Transcription model" ? value : saved.sttModel,
        }),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);

it.each([null, "space-edited"])("plays a sample for the bound space %s", async (spaceId) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  speak.mockClear();
  voice.catalog.mockResolvedValue([
    { id: "fish-audio", name: "Fish Audio", description: "", transcribe: true },
  ]);
  voice.credentials.mockResolvedValue([fish]);
  voice.status.mockResolvedValue({ ready: true, provider: fish.provider });
  voice.voices.mockResolvedValue([{ id: fish.voiceId, label: "Aria" }]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      const panel = <VoiceSettingsOverlay embedded onClose={() => undefined} />;
      root.render(spaceId ? <SpaceRpcProvider spaceId={spaceId}>{panel}</SpaceRpcProvider> : panel);
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Hear a sample")
        ?.click();
    });
    await vi.waitFor(() =>
      expect(speak).toHaveBeenCalledWith(
        "Hi, this is how I'll sound when I read replies out loud.",
        { spaceId },
      ),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
