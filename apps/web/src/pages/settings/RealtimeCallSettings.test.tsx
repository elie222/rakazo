// @vitest-environment jsdom

import type { RealtimeCallCapability, RealtimeCallState } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (parts: TemplateStringsArray) => parts.join(""),
    i18n: { locale: "en", number: (value: number) => String(value) },
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  FieldDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Disclosure: ({ summary, children }: { summary: ReactNode; children?: ReactNode }) => (
    <div>
      {summary}
      {children}
    </div>
  ),
  OptionSelect: ({
    id,
    value,
    options,
    onValueChange,
  }: {
    id: string;
    value: string | null;
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
  }) => (
    <select id={id} value={value ?? ""} onChange={(event) => onValueChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const calls = vi.hoisted(() => ({ load: vi.fn(), set: vi.fn() }));
vi.mock("../../lib/calls/realtime-call", () => ({ loadRealtimeCallState: calls.load }));
vi.mock("../../lib/query/query", () => ({
  useSave: (options: {
    save: (input: unknown, client: unknown) => Promise<unknown>;
    onSaved?: (saved: unknown) => void;
  }) => ({
    pending: false,
    error: null,
    run: (input: unknown) =>
      void options
        .save(input, { voice: { realtime: { set: calls.set } } })
        .then((saved) => options.onSaved?.(saved)),
  }),
}));
vi.mock("../../lib/query/user-error", () => ({
  errorText: (_: unknown, fallback: string) => fallback,
}));

import { RealtimeCallSettingsSection } from "./RealtimeCallSettings";

function state(model: string, capabilities: RealtimeCallCapability[] = []): RealtimeCallState {
  return {
    available: true,
    settings: { provider: "voice-provider", model },
    providers: [
      {
        provider: "voice-provider",
        models: [{ id: "voice-model", label: "Voice model", capabilities }],
        voices: ["voice-a"],
      },
    ],
  };
}

let root: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  calls.load.mockReset();
  calls.set.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

async function render() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<RealtimeCallSettingsSection />));
  return container;
}

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("label")].map((label) => label.textContent);

it("stays hidden while no connected provider can hold a realtime call", async () => {
  calls.load.mockResolvedValue({ ...state(""), available: false, providers: [] });
  expect((await render()).textContent).toBe("");
});

it("offers only the model choice while the standard call is selected", async () => {
  calls.load.mockResolvedValue(state("", ["voice", "speed", "thinking"]));
  expect(labels(await render())).toEqual(["Realtime call model"]);
});

it("shows only the settings the chosen model supports", async () => {
  calls.load.mockResolvedValue(state("voice-model", ["voice", "speed"]));
  const container = await render();
  expect(labels(container)).toEqual(["Realtime call model", "Call voice", "Speaking speed"]);
  expect(container.textContent).not.toContain("Advanced");
});

it("saves a change together with the settings already chosen", async () => {
  calls.load.mockResolvedValue(state("voice-model", ["speed"]));
  calls.set.mockImplementation(async (settings) => ({
    ...state("voice-model", ["speed"]),
    settings,
  }));
  const container = await render();
  const speed = [...container.querySelectorAll("select")][1];
  if (!speed) throw new Error("Expected the speed choice");
  await act(async () => {
    speed.value = "1.25";
    speed.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(calls.set).toHaveBeenCalledWith({
    provider: "voice-provider",
    model: "voice-model",
    speed: 1.25,
  });
});
