// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeploymentVoiceSettings } from "./DeploymentVoiceSettings";

vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ size: _size, ...props }: ComponentProps<"button"> & { size?: string }) => (
    <button {...props} />
  ),
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  SectionHeading: ({ children }: { children?: ReactNode }) => <h3>{children}</h3>,
}));
vi.mock("./ai/primitives", () => ({ SuccessPop: () => null }));
const { deployment } = vi.hoisted(() => ({
  deployment: { get: vi.fn(), update: vi.fn(), voices: vi.fn() },
}));
// Like the real client, every property read returns a new object.
vi.mock("../lib/rpc", () => ({
  rpc: {
    get voice() {
      return {
        get deployment() {
          return { ...deployment };
        },
      };
    },
  },
}));

const providers = [
  { id: "elevenlabs", name: "ElevenLabs", description: "", transcribe: true },
  { id: "cartesia", name: "Cartesia", description: "", transcribe: false },
];
const unset = {
  provider: null,
  voiceId: "",
  keySaved: false,
  environmentProvider: "cartesia",
  providers,
};
const saved = {
  ...unset,
  provider: "elevenlabs",
  voiceId: "voice-a",
  keySaved: true,
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  deployment.voices.mockResolvedValue([
    { id: "voice-a", label: "Voice A" },
    { id: "voice-b", label: "Voice B" },
  ]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function field(label: string) {
  const id = [...host.querySelectorAll("label")].find(
    (node) => node.textContent === label,
  )?.htmlFor;
  return host.querySelector<HTMLInputElement & HTMLSelectElement>(`[id="${id}"]`);
}

/** Changes a field the way a person typing or picking would. */
function enter(label: string, value: string) {
  const element = field(label);
  if (!element) throw new Error(`no ${label} field`);
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

it("names the environment's provider while nothing is saved and offers catalog providers", async () => {
  deployment.get.mockResolvedValue(unset);
  await act(async () => root.render(<DeploymentVoiceSettings />));

  const options = [...(field("Provider")?.options ?? [])].map((option) => option.textContent);
  expect(options).toEqual(["Default (Cartesia)", "ElevenLabs", "Cartesia"]);
  expect(field("API key")).toBeNull();
  expect(deployment.voices).not.toHaveBeenCalled();
});

it("saves a provider with its key, then offers its voices without showing the key", async () => {
  deployment.get.mockResolvedValue(unset);
  deployment.update.mockResolvedValue(saved);
  await act(async () => root.render(<DeploymentVoiceSettings />));

  await act(async () => enter("Provider", "elevenlabs"));
  expect(field("API key")?.required).toBe(true);
  await act(async () => enter("API key", "test-voice-key"));
  await act(async () => host.querySelector("form")?.requestSubmit());

  expect(deployment.update).toHaveBeenCalledWith({
    provider: "elevenlabs",
    apiKey: "test-voice-key",
  });
  expect(field("API key")?.value).toBe("");
  expect(field("API key")?.placeholder).toBe("Saved");
  expect(field("API key")?.required).toBe(false);
  expect(field("Voice")?.value).toBe("voice-a");
  expect(host.textContent).not.toContain("test-voice-key");
});

it("changes the voice keeping the saved key, and clears back to the default", async () => {
  deployment.get.mockResolvedValue(saved);
  deployment.update.mockResolvedValueOnce({ ...saved, voiceId: "voice-b" });
  deployment.update.mockResolvedValueOnce(unset);
  const onSaved = vi.fn();
  await act(async () => root.render(<DeploymentVoiceSettings onSaved={onSaved} />));

  await act(async () => enter("Voice", "voice-b"));
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(deployment.update).toHaveBeenLastCalledWith({
    provider: "elevenlabs",
    apiKey: "",
    voiceId: "voice-b",
  });

  await act(async () => enter("Provider", ""));
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(deployment.update).toHaveBeenLastCalledWith({ provider: null, apiKey: "" });
  expect(field("API key")).toBeNull();
  expect(field("Voice")).toBeNull();
  // The page around it hears about the save and the reset.
  expect(onSaved).toHaveBeenCalledTimes(2);
});

it("shows why a save failed", async () => {
  deployment.get.mockResolvedValue(unset);
  deployment.update.mockRejectedValue(new Error("That key was rejected."));
  await act(async () => root.render(<DeploymentVoiceSettings />));
  await act(async () => enter("Provider", "cartesia"));
  await act(async () => enter("API key", "test-voice-key"));
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("That key was rejected.");
});
