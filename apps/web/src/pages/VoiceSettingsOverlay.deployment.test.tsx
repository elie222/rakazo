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

const deploymentVoice = vi.hoisted(() => ({ onSaved: undefined as (() => void) | undefined }));
vi.mock("../components/DeploymentVoiceSettings", () => ({
  DeploymentVoiceSettings: ({ onSaved }: { onSaved?: () => void }) => {
    deploymentVoice.onSaved = onSaved;
    return <div data-testid="deployment-voice-settings" />;
  },
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

import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

function withQueries(ui: ReactNode, client = new QueryClient()) {
  client.setDefaultOptions({ queries: { retry: false } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

it("shows admins the deployment's voice on the account page only", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  voice.catalog
    .mockReset()
    .mockResolvedValue([
      { id: "elevenlabs", name: "ElevenLabs", description: "", transcribe: true },
    ]);
  voice.credentials.mockReset().mockResolvedValue([]);
  voice.status.mockReset().mockResolvedValue({
    configured: true,
    ready: true,
    transcribe: true,
    provider: "elevenlabs",
    voiceId: "voice-a",
    deployment: true,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const block = () => container.querySelector('[data-testid="deployment-voice-settings"]');
  try {
    for (const [props, shown] of [
      [{ scope: "account", canConfigureDeployment: true }, true],
      [{ scope: "space", canConfigureDeployment: true }, false],
      [{ scope: "account" }, false],
    ] as const) {
      await act(async () => {
        root.render(
          withQueries(<VoiceSettingsOverlay embedded onClose={() => undefined} {...props} />),
        );
      });
      expect(Boolean(block())).toBe(shown);
    }
    // A saved deployment voice refreshes what this page says can speak.
    await act(async () => {
      root.render(
        withQueries(
          <VoiceSettingsOverlay
            embedded
            onClose={() => undefined}
            scope="account"
            canConfigureDeployment
          />,
        ),
      );
    });
    const reads = voice.status.mock.calls.length;
    await act(async () => deploymentVoice.onSaved?.());
    expect(voice.status.mock.calls.length).toBeGreaterThan(reads);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
