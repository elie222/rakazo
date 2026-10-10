// @vitest-environment jsdom

import type { Group } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
// The alert dialog's Cancel closes it through onOpenChange, as Base UI does.
let dismissDialog: (() => void) | undefined;
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => <span />,
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  AlertDialog: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => {
    dismissDialog = () => onOpenChange(false);
    return <div role="alertdialog">{children}</div>;
  },
  AlertDialogAction: (props: ComponentProps<"button">) => <button {...props} />,
  AlertDialogCancel: (props: ComponentProps<"button">) => (
    <button {...props} onClick={() => dismissDialog?.()} />
  ),
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import { GroupSettings } from "./GroupPanel";

const group: Group = {
  id: "group-1",
  spaceId: "space-1",
  name: "Review team",
  pinned: false,
  sectionId: null,
  archivedAt: null,
  members: [
    { botId: "bot-1", name: "Researcher", color: "blue" },
    { botId: "bot-2", name: "Writer", color: "green" },
  ],
  threadId: "thread-1",
  preview: "",
  unread: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

async function render(
  options: {
    onSave?: () => Promise<void>;
    onRemove?: () => Promise<void>;
    covered?: boolean;
    instance?: string;
  } = {},
) {
  const onRemove = vi.fn(options.onRemove ?? (async () => undefined));
  const onClose = vi.fn();
  await act(async () => {
    root.render(
      <GroupSettings
        key={options.instance}
        group={group}
        bots={[]}
        onSave={options.onSave ?? (async () => undefined)}
        onRemove={onRemove}
        onClose={onClose}
        covered={options.covered}
      />,
    );
  });
  return { onRemove, onClose };
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent === name,
  );
  if (!found) throw new Error(`Missing ${name} button`);
  return found;
}

async function click(name: string) {
  await act(async () => {
    button(name).click();
    await Promise.resolve();
  });
}

async function pressEscape(isComposing = false) {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", cancelable: true, isComposing }),
    );
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

describe("GroupSettings", () => {
  it("closes from the header button", async () => {
    const { onClose } = await render();
    await click("Close panel");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", async () => {
    const { onClose } = await render();
    await pressEscape();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("leaves Escape to an input method that is composing", async () => {
    const { onClose } = await render();
    await pressEscape(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves Escape to an overlay on top of the panel", async () => {
    const { onClose } = await render({ covered: true });
    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open until a save in flight finishes, then closes", async () => {
    let finishSave!: () => void;
    const { onClose } = await render({
      onSave: () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    });
    await click("Save");
    expect(button("Close panel").disabled).toBe(true);
    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finishSave());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open with the error when the save fails", async () => {
    const { onClose } = await render({
      onSave: async () => {
        throw new Error("Name is taken");
      },
    });
    await click("Save");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Name is taken");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close the panel of a chat opened while the save was in flight", async () => {
    let finishSave!: () => void;
    const first = await render({
      onSave: () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    });
    await click("Save");
    const second = await render({ instance: "another chat" });
    await act(async () => finishSave());
    expect(first.onClose).not.toHaveBeenCalled();
    expect(second.onClose).not.toHaveBeenCalled();
  });

  it("asks before deleting the group", async () => {
    const { onRemove } = await render();
    await click("Delete group");
    expect(onRemove).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Delete Review team?",
    );
    await click("Delete");
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("keeps the group and the panel when the confirmation is dismissed", async () => {
    const { onRemove, onClose } = await render();
    await click("Delete group");
    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    await click("Cancel");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
