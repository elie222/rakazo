// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
    Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
      (value === 1 ? one : other).replace("#", String(value)),
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Field: Box,
    FieldLabel: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Dialog: Box,
    DialogContent: Box,
    DialogDescription: Box,
    DialogFooter: Box,
    DialogHeader: Box,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    AlertDialog: Box,
    AlertDialogAction: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    AlertDialogCancel: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    AlertDialogContent: Box,
    AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    AlertDialogFooter: Box,
    AlertDialogHeader: Box,
    AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    RadioGroup: Box,
    RadioGroupItem: Box,
  };
});

import { SpaceSettingsPanel } from "./SpaceSettingsPanel";

let container: HTMLDivElement;
let root: Root;

type Props = ComponentProps<typeof SpaceSettingsPanel>;

async function render(props: Partial<Props>) {
  await act(async () => {
    root.render(
      <SpaceSettingsPanel
        space={{ id: "space-a", name: "Support", canRename: true, canDelete: true, botCount: 0 }}
        onRename={async () => undefined}
        onDelete={async () => undefined}
        {...props}
      />,
    );
  });
}

function button(label: string) {
  return [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
}

async function click(label: string) {
  const target = button(label);
  if (!target) throw new Error(`Missing ${label}`);
  await act(async () => {
    target.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function type(value: string) {
  const input = container.querySelector("input");
  if (!input) throw new Error("Missing name field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  const form = container.querySelector("form");
  if (!form) throw new Error("Missing form");
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SpaceSettingsPanel", () => {
  it("renames the space in place", async () => {
    const onRename = vi.fn(async () => undefined);
    await render({ onRename });
    await click("Rename space");
    expect(container.querySelector("input")?.value).toBe("Support");
    await type("  Help desk  ");
    await submit();
    expect(onRename).toHaveBeenCalledWith("Help desk");
    expect(container.querySelector("input")).toBeNull();
  });

  it("falls back to the generic error when the failure message is blank", async () => {
    await render({
      onRename: async () => {
        throw new Error("   ");
      },
    });
    await click("Rename space");
    await type("Help desk");
    await submit();
    expect(container.textContent).toContain("Could not rename space");
  });

  it("shows neither rename nor delete to a space it cannot change", async () => {
    await render({
      space: { id: "space-a", name: "Personal", canRename: false, canDelete: false },
    });
    expect(container.textContent).toContain("Personal");
    expect(button("Rename space")).toBeUndefined();
    expect(button("Delete space")).toBeUndefined();
  });

  it("names the bots that go with the space before deleting it", async () => {
    const onDelete = vi.fn(async () => undefined);
    await render({
      space: {
        id: "space-a",
        name: "Support",
        canRename: true,
        canDelete: true,
        botCount: 2,
      },
      onDelete,
    });
    await click("Delete space");
    expect(container.querySelector("h2")?.textContent).toBe("Delete Support and its 2 bots?");
    await click("Delete");
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("asks plainly when the space has no bots", async () => {
    await render({});
    await click("Delete space");
    expect(container.querySelector("h2")?.textContent).toBe("Delete Support?");
  });
});
