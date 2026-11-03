// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
vi.mock("@rakazo/ui-web", () => {
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
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { SpaceRpcProvider } from "../lib/space-rpc";
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

it("selects an available provider when the saved self-hosted provider is hidden", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voice.catalog.mockResolvedValue([
    { id: "elevenlabs", name: "ElevenLabs", description: "", transcribe: true },
  ]);
  voice.credentials
    .mockResolvedValueOnce([{ ...fish, provider: "openai-compatible" }])
    .mockResolvedValue([]);
  voice.disconnect.mockClear().mockResolvedValue(undefined);
  voice.status.mockResolvedValue({ ready: true, provider: "openai-compatible" });
  voice.voices.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        withQueries(<VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />),
      );
    });
    expect(container.textContent).toContain("ElevenLabs");
    expect(container.textContent).not.toContain("Server URL");
    expect(container.querySelector('input[placeholder="Paste your API key"]')).not.toBeNull();
    expect(voice.voices).not.toHaveBeenCalled();
    const disconnect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Disconnect Self-hosted",
    );
    expect(disconnect).toBeTruthy();
    await act(async () => disconnect!.click());
    expect(voice.disconnect).toHaveBeenCalledWith({ provider: "openai-compatible" });
    expect(container.textContent).not.toContain("Self-hosted");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

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
  const chooseProvider = (value: string) => {
    const select = container.querySelector("select");
    if (!select) throw new Error("Missing provider select");
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
  try {
    await act(async () => {
      root.render(
        withQueries(<VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const input = speechModelInput(container);
    expect(input).toBeTruthy();
    expect(input?.placeholder).toBe("Optional");

    await act(async () => {
      chooseProvider("elevenlabs");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(speechModelInput(container)).toBeUndefined();

    await act(async () => {
      chooseProvider("fish-audio");
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
      scope: "account",
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
      root.render(
        withQueries(<VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />),
      );
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
      scope: "account",
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
        root.render(
          withQueries(<VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />),
        );
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
      const panel = <VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />;
      root.render(
        withQueries(
          spaceId ? <SpaceRpcProvider spaceId={spaceId}>{panel}</SpaceRpcProvider> : panel,
        ),
      );
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Hear a sample")
        ?.click();
    });
    await vi.waitFor(() =>
      expect(speak).toHaveBeenCalledWith(
        "Hi, this is how I'll sound when I read replies out loud.",
        { spaceId, scope: "account" },
      ),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("reopens with the cached providers and refreshes them in the background", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voice.catalog
    .mockReset()
    .mockResolvedValue([
      { id: "elevenlabs", name: "ElevenLabs", description: "", transcribe: true },
    ]);
  voice.credentials.mockReset().mockResolvedValue([eleven]);
  voice.status.mockReset().mockResolvedValue({ ready: true, provider: "elevenlabs" });
  voice.voices.mockReset().mockResolvedValue([{ id: "rachel", label: "Rachel" }]);
  const client = new QueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const mount = async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        withQueries(
          <VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />,
          client,
        ),
      );
    });
    return root;
  };
  try {
    const first = await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("Rachel"));
    await act(async () => first.unmount());

    let releaseCatalog: () => void = () => undefined;
    voice.catalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCatalog = () =>
            resolve([{ id: "elevenlabs", name: "ElevenLabs", description: "", transcribe: true }]);
        }),
    );
    const second = await mount();
    expect(container.querySelector('[aria-label="Loading voice providers…"]')).toBeNull();
    expect(container.textContent).toContain("ElevenLabs");
    expect(container.textContent).toContain("Rachel");
    expect(voice.catalog).toHaveBeenCalledTimes(2);
    await act(async () => releaseCatalog());
    await act(async () => second.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps the provider picked during a background refresh and only its voices", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const catalog = [
    { id: "fish-audio", name: "Fish Audio", description: "", transcribe: true },
    { id: "elevenlabs", name: "ElevenLabs", description: "", transcribe: true },
  ];
  voice.catalog.mockReset().mockResolvedValue(catalog);
  voice.credentials.mockReset().mockResolvedValue([fish, eleven]);
  voice.status.mockReset().mockResolvedValue({ ready: true, provider: "fish-audio" });
  voice.voices
    .mockReset()
    .mockImplementation(async ({ provider }: { provider?: string }) =>
      provider === "elevenlabs"
        ? [{ id: "rachel", label: "Rachel" }]
        : [{ id: "voice-1", label: "Aria" }],
    );
  const client = new QueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const mount = async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        withQueries(
          <VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />,
          client,
        ),
      );
    });
    return root;
  };
  try {
    const first = await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("Aria"));
    await act(async () => first.unmount());

    let releaseCatalog: () => void = () => undefined;
    voice.catalog.mockImplementationOnce(
      () => new Promise((resolve) => (releaseCatalog = () => resolve(catalog))),
    );
    const second = await mount();
    await act(async () => {
      const select = container.querySelector("select");
      if (!select) throw new Error("Missing provider select");
      select.value = "elevenlabs";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Rachel"));
    await act(async () => releaseCatalog());
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("select")?.value).toBe("elevenlabs");
    expect(container.textContent).toContain("Rachel");
    expect(container.textContent).not.toContain("Aria");
    await act(async () => second.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows what a disconnect left, not a read sent before it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voice.catalog
    .mockReset()
    .mockResolvedValue([
      { id: "elevenlabs", name: "ElevenLabs", description: "", transcribe: true },
    ]);
  voice.credentials.mockReset().mockResolvedValue([eleven]);
  voice.status.mockReset().mockResolvedValue({ ready: true, provider: "elevenlabs" });
  voice.voices.mockReset().mockResolvedValue([{ id: "rachel", label: "Rachel" }]);
  voice.disconnect.mockReset().mockResolvedValue(undefined);
  const client = new QueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const mount = async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        withQueries(
          <VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />,
          client,
        ),
      );
    });
    return root;
  };
  try {
    const first = await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("Rachel"));
    await act(async () => first.unmount());

    // The revisit's background read still says connected when the disconnect lands.
    let releaseStale: () => void = () => undefined;
    voice.credentials
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseStale = () => resolve([eleven]))),
      )
      .mockResolvedValue([]);
    const second = await mount();
    const disconnect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Disconnect",
    );
    if (!disconnect) throw new Error("Missing disconnect button");
    await act(async () => disconnect.click());
    await act(async () => releaseStale());
    await vi.waitFor(() =>
      expect(container.querySelector('input[placeholder="Paste your API key"]')).not.toBeNull(),
    );
    expect(voice.credentials).toHaveBeenCalledTimes(3);
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Disconnect",
    );
    await act(async () => second.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("lets a background refresh update untouched fields but keeps edited ones", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const catalog = [
    {
      id: "openai-compatible",
      name: "Self-hosted",
      description: "",
      transcribe: true,
    },
  ];
  const saved = {
    ...fish,
    provider: "openai-compatible",
    voiceId: "",
    endpoint: "http://127.0.0.1:8000/v1",
    ttsModel: "tts-old",
    sttModel: "stt-old",
  };
  voice.catalog.mockReset().mockResolvedValue(catalog);
  voice.credentials.mockReset().mockResolvedValue([saved]);
  voice.status.mockReset().mockResolvedValue({ ready: true, provider: "openai-compatible" });
  voice.voices.mockReset().mockResolvedValue([]);
  const client = new QueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const mount = async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        withQueries(
          <VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />,
          client,
        ),
      );
    });
    return root;
  };
  try {
    const first = await mount();
    await vi.waitFor(() =>
      expect(labelledInput(container, "Server URL").value).toBe(saved.endpoint),
    );
    await act(async () => first.unmount());

    // Another device changed the saved models while this page was closed.
    let releaseCredentials: () => void = () => undefined;
    voice.credentials.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCredentials = () =>
            resolve([{ ...saved, ttsModel: "tts-new", sttModel: "stt-new" }]);
        }),
    );
    const second = await mount();
    const tts = labelledInput(container, "Speech model");
    expect(tts.value).toBe("tts-old");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(tts, "tts-typed");
      tts.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => releaseCredentials());
    await vi.waitFor(() =>
      expect(labelledInput(container, "Transcription model").value).toBe("stt-new"),
    );
    expect(labelledInput(container, "Speech model").value).toBe("tts-typed");
    await act(async () => second.unmount());
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("picks a Space's own voice from the account's connections without managing them", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voice.catalog
    .mockReset()
    .mockResolvedValue([
      { id: "fish-audio", name: "Fish Audio", description: "", transcribe: true },
    ]);
  voice.credentials.mockReset().mockResolvedValue([fish]);
  voice.status.mockReset().mockResolvedValue({ ready: true, provider: "fish-audio" });
  voice.voices.mockReset().mockResolvedValue([
    { id: "voice-1", label: "Aria" },
    { id: "voice-2", label: "Bo" },
  ]);
  voice.setVoice.mockReset().mockResolvedValue({ ready: true, provider: "fish-audio" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        withQueries(<VoiceSettingsOverlay embedded scope="space" onClose={() => undefined} />),
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Hear a sample"));
    expect(voice.credentials).toHaveBeenCalledWith({ scope: "space" }, expect.anything());
    expect(voice.status).toHaveBeenCalledWith({ scope: "space" }, expect.anything());
    // The connection itself belongs to the account.
    expect(container.querySelector('input[type="password"]')).toBeNull();
    const buttons = [...container.querySelectorAll("button")].map((item) => item.textContent);
    expect(buttons).not.toContain("Disconnect");
    expect(buttons).not.toContain("Replace key");

    const voiceSelect = container.querySelectorAll("select")[1];
    if (!voiceSelect) throw new Error("Missing voice select");
    await act(async () => {
      voiceSelect.value = "voice-2";
      voiceSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(voice.setVoice).toHaveBeenCalledWith({
      scope: "space",
      voiceId: "voice-2",
      provider: "fish-audio",
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("saves a typed self-hosted voice on blur without dropping other unsaved edits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const saved = {
    ...fish,
    provider: "openai-compatible",
    voiceId: "af_heart",
    endpoint: "http://127.0.0.1:8000/v1",
    ttsModel: "",
    sttModel: "",
  };
  voice.catalog
    .mockReset()
    .mockResolvedValue([
      { id: "openai-compatible", name: "Self-hosted", description: "", transcribe: true },
    ]);
  voice.credentials.mockReset().mockResolvedValue([saved]);
  voice.status.mockReset().mockResolvedValue({ ready: true, provider: "openai-compatible" });
  voice.voices.mockReset().mockResolvedValue([{ id: "af_heart", label: "Heart" }]);
  voice.setVoice.mockReset().mockResolvedValue({ ready: true, provider: "openai-compatible" });
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
  const blur = async (input: HTMLInputElement) => {
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
  };
  try {
    await act(async () => {
      root.render(
        withQueries(<VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />),
      );
    });
    await vi.waitFor(() => expect(labelledInput(container, "Voice").value).toBe("af_heart"));

    await blur(labelledInput(container, "Voice"));
    await type(labelledInput(container, "Voice"), "  ");
    await blur(labelledInput(container, "Voice"));
    expect(voice.setVoice).not.toHaveBeenCalled();

    await type(labelledInput(container, "Server URL"), "http://127.0.0.1:9000/v1");
    await type(labelledInput(container, "Voice"), " am_custom ");
    await blur(labelledInput(container, "Voice"));
    expect(voice.setVoice).toHaveBeenCalledWith({
      scope: "account",
      voiceId: "am_custom",
      provider: "openai-compatible",
    });
    await vi.waitFor(() => expect(voice.credentials).toHaveBeenCalledTimes(2));
    expect(labelledInput(container, "Server URL").value).toBe("http://127.0.0.1:9000/v1");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("connects a keyless provider without asking for a key", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voice.catalog.mockResolvedValue([
    { id: "macos", name: "Server (Mac)", description: "", transcribe: false, keyless: true },
  ]);
  voice.credentials.mockResolvedValue([]);
  voice.status.mockResolvedValue({
    configured: false,
    ready: false,
    transcribe: false,
    provider: null,
    voiceId: "",
  });
  voice.connect.mockClear().mockResolvedValue(undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        withQueries(<VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />),
      );
    });
    expect(container.textContent).not.toContain("API key");
    const connect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect",
    );
    expect(connect?.disabled).toBe(false);
    await act(async () => connect!.click());
    expect(voice.connect).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "macos", apiKey: "" }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each(["account", "space"] as const)(
  "activates a connected keyless provider with one voice in %s settings",
  async (scope) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    voice.catalog.mockResolvedValue([
      { id: "fish-audio", name: "Fish Audio", description: "", transcribe: true },
      { id: "macos", name: "Server (Mac)", description: "", transcribe: false, keyless: true },
    ]);
    voice.credentials.mockResolvedValue([
      fish,
      { ...eleven, id: "cred-macos", provider: "macos", voiceId: "Albert", transcribe: false },
    ]);
    voice.status.mockResolvedValue({ ready: true, provider: "fish-audio", voiceId: "voice-1" });
    voice.voices.mockResolvedValue([{ id: "Albert", label: "Albert" }]);
    const saved = { ready: true, provider: "macos", voiceId: "Albert" };
    voice.setVoice.mockClear().mockResolvedValue(saved);
    const client = new QueryClient();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          withQueries(
            <VoiceSettingsOverlay embedded scope={scope} onClose={() => undefined} />,
            client,
          ),
        );
      });
      const select = [...container.querySelectorAll("select")].find((select) =>
        [...select.options].some((option) => option.value === "macos"),
      );
      expect(select).toBeTruthy();
      await act(async () => {
        select!.value = "macos";
        select!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(voice.setVoice).toHaveBeenCalledExactlyOnceWith({
        scope,
        provider: "macos",
        voiceId: "Albert",
      });
      expect(container.textContent).not.toContain("API key");
      expect(container.textContent).not.toContain("Replace key");
      expect(
        [...container.querySelectorAll("select")].find((select) => select.value === "Albert"),
      ).toBeTruthy();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      client.clear();
      vi.unstubAllGlobals();
    }
  },
);
