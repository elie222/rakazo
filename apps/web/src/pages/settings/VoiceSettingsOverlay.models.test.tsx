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
  const { OptionSelect, SwitchField } = await importOriginal<typeof UiWeb>();
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
    SwitchField,
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

it("offers the speech models a provider lists and follows the new model's voices", async () => {
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
  voice.voices.mockReset().mockImplementation(async () =>
    model === router.speechModel
      ? [
          { id: "alloy", label: "alloy" },
          { id: "nova", label: "nova" },
        ]
      : [{ id: "en_paul", label: "en_paul" }],
  );
  voice.models.mockReset().mockResolvedValue([
    { id: "mistralai/voxtral-mini-tts-2603", label: "Mistral: Voxtral" },
    { id: router.speechModel, label: "OpenAI: GPT-4o Mini TTS" },
  ]);
  voice.setSpeechModel.mockReset().mockImplementation(async (input: { speechModel: string }) => {
    model = input.speechModel;
    return { ...router, speechModel: input.speechModel, voiceId: "en_paul" };
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
    const selects = () => [...container.querySelectorAll<HTMLElement>('[role="combobox"]')];
    // Provider, voice and speech model, once the model list has loaded.
    await vi.waitFor(() => expect(selects()).toHaveLength(3));
    expect(selects()[1]?.textContent).toContain("alloy");
    expect(speechModelInput(container)).toBeUndefined();
    const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

    // A voice picked earlier must not keep the form from following the next model change.
    await act(async () => selects()[1]!.click());
    await act(async () =>
      options()
        .find((option) => option.textContent === "nova")!
        .click(),
    );
    expect(voice.setVoice).toHaveBeenCalledWith({
      scope: "account",
      voiceId: "nova",
      provider: "openrouter",
    });

    await act(async () => selects()[2]!.click());
    expect(options().map((option) => option.textContent)).toEqual([
      "Default",
      "Mistral: Voxtral",
      "OpenAI: GPT-4o Mini TTS",
    ]);
    await act(async () =>
      options()
        .find((option) => option.textContent === "Mistral: Voxtral")!
        .click(),
    );

    expect(voice.setSpeechModel).toHaveBeenCalledWith({
      scope: "account",
      provider: "openrouter",
      speechModel: "mistralai/voxtral-mini-tts-2603",
    });
    await vi.waitFor(() => expect(selects()[1]?.textContent).toContain("en_paul"));
    expect(voice.setVoice).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
