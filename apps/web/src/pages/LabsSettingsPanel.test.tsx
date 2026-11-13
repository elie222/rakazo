// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

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
  const container = await render({ labs: [], onLabsChange });
  expect(container.textContent).toContain("Board");
  const toggle = container.querySelector<HTMLButtonElement>('[data-testid="lab-board-toggle"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("false");

  await act(async () => toggle?.click());

  expect(onLabsChange).toHaveBeenCalledExactlyOnceWith(["board"]);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("turns Board off and shows an error when the save fails", async () => {
  const onLabsChange = vi.fn(async () => {
    throw new Error("offline");
  });
  const container = await render({ labs: ["board"], onLabsChange });

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="lab-board-toggle"]')?.click(),
  );

  expect(onLabsChange).toHaveBeenCalledExactlyOnceWith([]);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn't update Labs");
});
