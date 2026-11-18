// @vitest-environment jsdom

import type * as UiWeb from "@rakazo/ui-web";
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
  models: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  setVoice: vi.fn(),
  setSpeechModel: vi.fn(),
}));

const { speak, activeCall } = vi.hoisted(() => ({
  speak: vi.fn(async () => undefined),
  activeCall: { current: null as { phase: string } | null },
}));
vi.mock("../../lib/calls/tts.js", () => ({ speaker: { speak, state: {} } }));
vi.mock("../../lib/calls/call-session", () => ({ useCallSession: () => activeCall.current }));
vi.mock("../../lib/query/rpc", () => ({
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

const fish = {
  id: "cred-fish",
  provider: "fish-audio",
  hasKey: true,
  isDefault: true,
  voiceId: "voice-1",
  speechModel: "",
  transcribe: true,
};

function labelledInput(container: HTMLElement, text: string): HTMLInputElement {
  const found = [...container.querySelectorAll("input")].find(
    (input) => container.querySelector(`label[for="${input.id}"]`)?.textContent === text,
  );
  if (!found) throw new Error(`Missing field: ${text}`);
  return found;
}

function speechModelInput(container: HTMLElement): HTMLInputElement | undefined {
  return [...container.querySelectorAll("input")].find((input) => {
    const label = container.querySelector(`label[for="${input.id}"]`);
    return label?.textContent === "Speech model";
  });
}

function withQueries(ui: ReactNode, client = new QueryClient()) {
  client.setDefaultOptions({ queries: { retry: false } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

it("suggests the speech models a provider lists and follows the new model's voices", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const router = {
    ...fish,
    id: "cred-router",
    provider: "openrouter",
    voiceId: "alloy",
    speechModel: "openai/gpt-4o-mini-tts-2025-12-15",
  };
  voice.catalog.mockReset().mockResolvedValue([
    {
      id: "openrouter",
      name: "OpenRouter",
      description: "",
      transcribe: true,
      speechModel: true,
      speechModels: true,
      freeformVoice: true,
    },
  ]);
  voice.credentials.mockReset().mockResolvedValue([router]);
  voice.status.mockReset().mockResolvedValue({ ready: true, provider: "openrouter" });
  let model = router.speechModel;
  voice.voices
    .mockReset()
    .mockImplementation(async () =>
      model === router.speechModel
        ? [{ id: "alloy", label: "alloy" }]
        : [{ id: "en_paul", label: "en_paul" }],
    );
  voice.models.mockReset().mockResolvedValue([
    { id: "mistralai/voxtral-mini-tts-2603", label: "Mistral: Voxtral" },
    { id: router.speechModel, label: "OpenAI: GPT-4o Mini TTS" },
  ]);
  voice.setSpeechModel.mockReset().mockImplementation(async (input: { speechModel: string }) => {
    model = input.speechModel;
    return { ...router, speechModel: input.speechModel };
  });
  voice.setVoice.mockReset().mockResolvedValue({ ready: true, provider: "openrouter" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        withQueries(<VoiceSettingsOverlay embedded scope="account" onClose={() => undefined} />),
      );
    });
    const input = await vi.waitFor(() => {
      const found = speechModelInput(container);
      if (!found) throw new Error("Missing speech model field");
      return found;
    });
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll(`datalist[id="${input.list?.id}"] option`)].map(
          (option) => (option as HTMLOptionElement).value,
        ),
      ).toEqual(["mistralai/voxtral-mini-tts-2603", router.speechModel]),
    );
    expect(labelledInput(container, "Voice").value).toBe("alloy");

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "mistralai/voxtral-mini-tts-2603");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    await vi.waitFor(() =>
      expect(voice.setVoice).toHaveBeenCalledWith({
        scope: "account",
        voiceId: "en_paul",
        provider: "openrouter",
      }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
