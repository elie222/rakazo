// @vitest-environment jsdom
import type { SpaceMemoryConfig } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { connectProvider, setDefaultScope } = vi.hoisted(() => ({
  connectProvider: vi.fn(),
  setDefaultScope: vi.fn(),
}));
vi.mock("../lib/space-rpc", () => ({
  useSpaceRpc: () => ({ memory: { connectProvider, setDefaultScope } }),
}));
vi.mock("./KnowledgeSection", () => ({ SpaceMemorySection: () => null }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + (i ? values[i - 1] : "") + part, ""),
  }),
}));
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Button = ({
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { variant?: string }) => <button {...props} />;
  return {
    Button,
    Dialog: Box,
    DialogClose: Box,
    DialogContent: Box,
    DialogTitle: Box,
    AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogContent: Box,
    AlertDialogHeader: Box,
    AlertDialogTitle: Box,
    AlertDialogDescription: Box,
    AlertDialogFooter: Box,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    Field: Box,
    FieldLabel: (props: ComponentProps<"label">) => (
      <label htmlFor={props.htmlFor}>{props.children}</label>
    ),
    FieldError: Box,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Spinner: Box,
    Toggle: ({
      pressed,
      onPressedChange,
      ...props
    }: ComponentProps<"button"> & { pressed: boolean; onPressedChange: () => void }) => (
      <button aria-pressed={pressed} onClick={onPressedChange} {...props} />
    ),
  };
});

import { MemorySettingsOverlay } from "./MemorySettingsOverlay";

let container: HTMLDivElement;
let root: Root;
const onConfigChange = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(config: SpaceMemoryConfig | null = null) {
  await act(async () =>
    root.render(
      <MemorySettingsOverlay
        embedded
        config={config}
        onClose={() => undefined}
        onConfigChange={onConfigChange}
      />,
    ),
  );
}
function button(name: string) {
  const found = [...container.querySelectorAll("button")].find((node) => node.textContent === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function select(provider: string) {
  await act(async () => {
    const node = container.querySelector("select")!;
    node.value = provider;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function fill(label: string, value: string) {
  await act(async () => {
    const id = [...container.querySelectorAll("label")].find(
      (node) => node.textContent === label,
    )!.htmlFor;
    const input = document.getElementById(id)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("keeps legacy providers isolated and requires explicit sharing confirmation without losing rejected drafts", async () => {
  await render();
  await click("Connect memory provider");
  expect(button("Isolated").disabled).toBe(false);
  expect(button("Isolated").getAttribute("aria-pressed")).toBe("true");
  await select("rembric");
  expect(button("Isolated").disabled).toBe(true);
  expect(button("Shared").getAttribute("aria-pressed")).toBe("true");
  await fill("MCP endpoint", "https://memory.example.com/mcp/space-example");
  await fill("Bearer token", "fake-token");
  await click("Connect");
  expect(connectProvider).not.toHaveBeenCalled();
  await click("Cancel");
  expect(connectProvider).not.toHaveBeenCalled();
  await click("Connect");
  connectProvider.mockRejectedValueOnce(new Error("Project unavailable"));
  await click("Use shared memory");
  expect(connectProvider).toHaveBeenCalledWith({
    provider: "rembric",
    settings: { endpoint: "https://memory.example.com/mcp/space-example" },
    credentials: { token: "fake-token" },
    defaultMemoryScope: "shared",
    confirmSharedScope: true,
  });
  expect(container.textContent).toContain("Project unavailable");
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(
    "fake-token",
  );
  await select("honcho");
  expect(button("Isolated").disabled).toBe(false);
  expect(button("Isolated").getAttribute("aria-pressed")).toBe("true");
});
it("connects existing providers without a sharing authorization flag", async () => {
  await render();
  await click("Connect memory provider");
  await select("honcho");
  await fill("API key", "fake-honcho-key");
  connectProvider.mockResolvedValueOnce({
    provider: "honcho",
    settings: {},
    defaultMemoryScope: "isolated",
  });
  await click("Connect");
  expect(connectProvider).toHaveBeenCalledWith({
    provider: "honcho",
    settings: {},
    credentials: { apiKey: "fake-honcho-key" },
    defaultMemoryScope: "isolated",
  });
  expect(onConfigChange).toHaveBeenCalled();
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
});
it("disables isolated only for an explicit active capability", async () => {
  const config: SpaceMemoryConfig = {
    provider: "honcho",
    settings: {},
    defaultMemoryScope: "shared",
  } as SpaceMemoryConfig;
  await render(config);
  expect(button("Isolated").disabled).toBe(false);
  await render({ ...config, capabilities: { isolatedScope: false } });
  expect(button("Isolated").disabled).toBe(true);
});
