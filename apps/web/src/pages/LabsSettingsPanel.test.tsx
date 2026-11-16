// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createQueryRoot as createRoot } from "../lib/query-root.test-support";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Label: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    "data-testid": testId,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

const client = vi.hoisted(() => ({ preferences: {} }));
vi.mock("../lib/rpc", () => ({
  rpc: client,
  rpcForSpace: () => client,
  createSpaceRpc: () => client,
  selectedSpaceId: () => null,
}));

import { LabsSettingsPanel } from "./LabsSettingsPanel";

let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

async function render(props: React.ComponentProps<typeof LabsSettingsPanel>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<LabsSettingsPanel {...props} />));
  return container;
}

it("turns Board on by saving the whole Labs list", async () => {
  const onLabsChange = vi.fn(async () => undefined);
  const container = await render({ labs: [], available: ["board"], onLabsChange });
  expect(container.textContent).toContain("Board");
  const toggle = container.querySelector<HTMLButtonElement>('[data-testid="lab-board-toggle"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("false");

  await act(async () => toggle?.click());

  expect(onLabsChange).toHaveBeenCalledExactlyOnceWith(["board"], client);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("turns Board off and shows an error when the save fails", async () => {
  const onLabsChange = vi.fn(async () => {
    throw new Error("offline");
  });
  const container = await render({ labs: ["board"], available: ["board"], onLabsChange });

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="lab-board-toggle"]')?.click(),
  );

  expect(onLabsChange).toHaveBeenCalledExactlyOnceWith([], client);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't update Labs");
});

it("holds the switch while the save is in flight and sends one save for a double click", async () => {
  const pending = deferred<void>();
  const onLabsChange = vi.fn(() => pending.promise);
  const container = await render({ labs: [], available: ["board"], onLabsChange });
  const toggle = container.querySelector<HTMLButtonElement>('[data-testid="lab-board-toggle"]');

  await act(async () => {
    toggle?.click();
    toggle?.click();
  });

  expect(onLabsChange).toHaveBeenCalledTimes(1);
  expect(toggle?.disabled).toBe(true);
  await act(async () => pending.resolve());
  expect(toggle?.disabled).toBe(false);
});
