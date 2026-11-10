// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeploymentModelSettings } from "./DeploymentModelSettings";

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
  Label: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOptGroup: (props: ComponentProps<"optgroup">) => <optgroup {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  SectionHeading: ({ children }: { children?: ReactNode }) => <h3>{children}</h3>,
  Switch: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    id?: string;
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));
const { deployment } = vi.hoisted(() => ({
  deployment: {
    get: vi.fn(),
    update: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    probe: vi.fn(),
  },
}));
// Like the real client, every property read returns a new object.
vi.mock("../lib/rpc", () => ({
  rpc: {
    get models() {
      return {
        get deployment() {
          return { ...deployment };
        },
      };
    },
  },
}));

const settings = {
  defaultModel: null,
  effectiveDefault: { provider: "deepseek", modelId: "deepseek-flash" },
  allowedModels: null,
  effectiveAllowedModels: ["deepseek:*"],
  connections: [
    {
      provider: "deepseek",
      name: "DeepSeek",
      saved: false,
      open: true,
      models: [
        { id: "deepseek-flash", label: "DeepSeek Flash" },
        { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      ],
    },
    {
      provider: "anthropic",
      name: "Anthropic",
      saved: true,
      open: false,
      models: [{ id: "claude-opus-4-5", label: "Claude Opus 4.5" }],
    },
  ],
  providers: [
    { id: "anthropic", name: "Anthropic" },
    { id: "openai-compatible", name: "OpenAI-compatible", endpoint: true as const },
  ],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  deployment.get.mockResolvedValue(settings);
  for (const call of [deployment.update, deployment.connect, deployment.disconnect])
    call.mockResolvedValue(settings);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render() {
  await act(async () => {
    root.render(<DeploymentModelSettings />);
  });
}

const byLabel = <T extends HTMLElement>(text: string) => {
  const label = [...container.querySelectorAll("label")].find(
    (candidate) => candidate.textContent === text,
  );
  return container.querySelector<T>(`#${CSS.escape(label!.htmlFor)}`)!;
};

function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

it("shows the environment's default and saves an admin's choice", async () => {
  await render();
  const select = byLabel<HTMLSelectElement>("Model");
  expect(select.options[0]?.textContent).toBe("Default (DeepSeek Flash)");
  await act(async () => change(select, "anthropic\nclaude-opus-4-5"));
  expect(deployment.update).toHaveBeenCalledWith({
    defaultModel: { provider: "anthropic", modelId: "claude-opus-4-5" },
  });
});

it("asks the server to open or close a connection's models", async () => {
  await render();
  const deepseek = byLabel<HTMLInputElement>("DeepSeek");
  const anthropic = byLabel<HTMLInputElement>("Anthropic");
  expect(deepseek.checked).toBe(true);
  expect(anthropic.checked).toBe(false);
  await act(async () => anthropic.click());
  expect(deployment.update).toHaveBeenCalledWith({ open: { provider: "anthropic", open: true } });
  await act(async () => deepseek.click());
  expect(deployment.update).toHaveBeenLastCalledWith({
    open: { provider: "deepseek", open: false },
  });
});

it("resets a list saved in Settings", async () => {
  const named = {
    ...settings,
    allowedModels: ["anthropic:claude-opus-4-5"],
    effectiveAllowedModels: ["anthropic:claude-opus-4-5"],
  };
  deployment.get.mockResolvedValue(named);
  deployment.update.mockResolvedValue(named);
  await render();
  const reset = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Reset",
  )!;
  await act(async () => reset.click());
  expect(deployment.update).toHaveBeenLastCalledWith({ allowedModels: null });
});

it("offers no reset while the server's own list applies", async () => {
  await render();
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Reset"),
  ).toBe(false);
});

it("removes only a connection saved in Settings", async () => {
  await render();
  const remove = [...container.querySelectorAll("button")].filter(
    (button) => button.textContent === "Remove",
  );
  expect(remove).toHaveLength(1);
  await act(async () => remove[0]!.click());
  expect(deployment.disconnect).toHaveBeenCalledWith({ provider: "anthropic" });
});

it("connects a compatible endpoint with its URL, models and limits", async () => {
  await render();
  const add = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Add provider",
  )!;
  await act(async () => add.click());
  await act(async () => change(byLabel<HTMLSelectElement>("Provider"), "openai-compatible"));
  await act(async () =>
    change(byLabel<HTMLInputElement>("Base URL"), "https://eu.example.test/v1"),
  );
  await act(async () => change(byLabel<HTMLInputElement>("API key"), "fixture-key"));
  await act(async () => change(byLabel<HTMLInputElement>("Models"), "model-a, model-b"));
  await act(async () => change(byLabel<HTMLInputElement>("Maximum output tokens"), "2048"));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(deployment.connect).toHaveBeenCalledWith({
    provider: "openai-compatible",
    apiKey: "fixture-key",
    baseUrl: "https://eu.example.test/v1",
    enabledModelIds: ["model-a", "model-b"],
    contextWindow: undefined,
    maxTokens: 2048,
  });
});
