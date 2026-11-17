// @vitest-environment jsdom

import type * as UiWeb from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { speak, activeCall } = vi.hoisted(() => ({
  speak: vi.fn(async () => undefined),
  activeCall: { current: null as { phase: string } | null },
}));
vi.mock("../lib/tts.js", () => ({ speaker: { speak, state: {} } }));
vi.mock("../lib/call-session", () => ({ useCallSession: () => activeCall.current }));
vi.mock("../lib/rpc", () => ({
  rpc: { voice },
  rpcForSpace: () => ({ voice }),
  createSpaceRpc: () => ({ voice }),
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const { OptionSelect } = await importOriginal<typeof UiWeb>();
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Spinner: (props: ComponentProps<"svg">) => <svg role="status" {...props} />,
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
    OptionSelect,
  };
});

import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

function withQueries(ui: ReactNode, client = new QueryClient()) {
  client.setDefaultOptions({ queries: { retry: false } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const fish = {
  id: "cred-fish",
  provider: "fish-audio",
  hasKey: true,
  isDefault: true,
  voiceId: "voice-1",
  speechModel: "",
  transcribe: true,
};
const _eleven = {
  id: "cred-eleven",
  provider: "elevenlabs",
  hasKey: true,
  isDefault: false,
  voiceId: "rachel",
  speechModel: "",
  transcribe: true,
};

function _speechModelInput(container: HTMLElement): HTMLInputElement | undefined {
  return [...container.querySelectorAll("input")].find((input) => {
    const label = container.querySelector(`label[for="${input.id}"]`);
    return label?.textContent === "Speech model";
  });
}

function labelledInput(container: HTMLElement, text: string): HTMLInputElement {
  const found = [...container.querySelectorAll("input")].find(
    (input) => container.querySelector(`label[for="${input.id}"]`)?.textContent === text,
  );
  if (!found) throw new Error(`Missing field: ${text}`);
  return found;
}

describe("a save that succeeded stays a success when the read after it fails", () => {
  const saved = {
    ...fish,
    provider: "openai-compatible",
    voiceId: "af_heart",
    endpoint: "https://speech.example/v1",
    ttsModel: "",
    sttModel: "",
  };
  // A body without a message, so the text shown is the caller's own fallback.
  const failure = {};
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const errorShown = (container: HTMLElement) =>
    container.querySelector("p.text-destructive")?.textContent ?? null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    voice.catalog
      .mockReset()
      .mockResolvedValue([
        { id: "openai-compatible", name: "Self-hosted", description: "", transcribe: true },
      ]);
    // The first read opens the form; the one after the save fails.
    voice.credentials.mockReset().mockResolvedValueOnce([saved]).mockRejectedValue(failure);
    voice.status.mockReset().mockResolvedValue({ ready: true, provider: "openai-compatible" });
    voice.voices.mockReset().mockResolvedValue([{ id: "af_heart", label: "Heart" }]);
    voice.connect.mockReset().mockResolvedValue(saved);
    voice.setVoice.mockReset().mockResolvedValue({ ready: true, provider: "openai-compatible" });
  });

  async function open() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        withQueries(<VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />),
      );
    });
    await vi.waitFor(() => expect(labelledInput(container, "Voice").value).toBe("af_heart"));
    return {
      container,
      close: async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      },
    };
  }

  it("reports a reconnect as connected", async () => {
    const { container, close } = await open();
    try {
      const reconnect = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Reconnect",
      );
      if (!reconnect) throw new Error("Missing reconnect button");
      await act(async () => {
        reconnect.click();
      });
      await vi.waitFor(() => expect(voice.credentials).toHaveBeenCalledTimes(2));
      // The test catalog leaves the provider name out of "Connected {name}.".
      await vi.waitFor(() =>
        expect(container.querySelector("p.text-success")?.textContent).toBe("Connected ."),
      );
      expect(errorShown(container)).not.toBe("Could not connect this voice provider");
    } finally {
      await close();
    }
  });

  it("does not report a saved voice as unsaved", async () => {
    const { container, close } = await open();
    try {
      await type(labelledInput(container, "Voice"), "am_custom");
      await act(async () => {
        labelledInput(container, "Voice").dispatchEvent(
          new FocusEvent("focusout", { bubbles: true }),
        );
      });
      expect(voice.setVoice).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(voice.credentials).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(errorShown(container)).not.toBeNull());
      expect(errorShown(container)).not.toBe("Could not save that voice");
    } finally {
      await close();
    }
  });
});

it("applies the voice a reconnect saved when the read after it fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const saved = {
    ...fish,
    provider: "openai-compatible",
    voiceId: "voice_old",
    endpoint: "https://speech-a.example/v1",
    ttsModel: "",
    sttModel: "",
  };
  // The new address makes the server pick another voice.
  const connected = { ...saved, endpoint: "https://speech-b.example/v1", voiceId: "voice_new" };
  voice.catalog
    .mockReset()
    .mockResolvedValue([
      { id: "openai-compatible", name: "Self-hosted", description: "", transcribe: true },
    ]);
  voice.credentials.mockReset().mockResolvedValueOnce([saved]).mockRejectedValue({});
  voice.status.mockReset().mockResolvedValue({ ready: true, provider: "openai-compatible" });
  voice.voices.mockReset().mockResolvedValue([]);
  let releaseConnect: () => void = () => undefined;
  voice.connect
    .mockReset()
    .mockImplementationOnce(
      () => new Promise((resolve) => (releaseConnect = () => resolve(connected))),
    )
    .mockResolvedValue(connected);
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
  const reconnect = async () => {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Reconnect",
    );
    if (!button) throw new Error("Missing reconnect button");
    await act(async () => {
      button.click();
    });
  };
  try {
    await act(async () => {
      root.render(
        withQueries(<VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />),
      );
    });
    await vi.waitFor(() => expect(labelledInput(container, "Voice").value).toBe("voice_old"));
    await type(labelledInput(container, "Server URL"), connected.endpoint);
    await reconnect();
    // An edit made while the request runs stays.
    await type(labelledInput(container, "Server URL"), "https://speech-c.example/v1");
    await act(async () => {
      releaseConnect();
    });
    await vi.waitFor(() => expect(voice.credentials).toHaveBeenCalledTimes(2));
    expect(labelledInput(container, "Voice").value).toBe("voice_new");
    expect(labelledInput(container, "Server URL").value).toBe("https://speech-c.example/v1");

    await reconnect();
    expect(voice.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ voiceId: "voice_new", baseUrl: "https://speech-c.example/v1" }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
