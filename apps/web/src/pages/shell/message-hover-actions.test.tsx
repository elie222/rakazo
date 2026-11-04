// @vitest-environment jsdom

import type { MessageReaction, ThreadMessage } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageHoverActions } from "./message-hover-actions";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`,
        "",
      ),
  }),
}));

const message: ThreadMessage = {
  id: "m1",
  threadId: "thread",
  seq: 2,
  role: "bot",
  createdAt: new Date().toISOString(),
  blocks: [{ kind: "text", text: "Answer text" }],
};

let root: Root;
let container: HTMLDivElement;

async function click(element: HTMLElement | null | undefined) {
  if (!element) throw new Error("Missing element");
  await act(async () => element.click());
}

function menuItem(label: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent === label,
  );
}

/** The jsdom of this file has no Clipboard API, like a plain-HTTP LAN origin. */
function stubExecCommand(capture: (active: Element | null) => boolean) {
  document.execCommand = vi.fn(() => capture(document.querySelector("textarea")));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <MessageHoverActions
        message={message}
        side="start"
        onReply={vi.fn()}
        onMarkUnread={vi.fn()}
        onReact={vi.fn<(message: ThreadMessage, reaction: MessageReaction) => Promise<void>>()}
      />,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(document, "execCommand");
});

it("copies a message through the selection fallback and confirms it", async () => {
  let copiedText = "";
  stubExecCommand((active) => {
    copiedText = active instanceof HTMLTextAreaElement ? active.value : "";
    return true;
  });
  expect(navigator.clipboard).toBeUndefined();

  await click(document.querySelector<HTMLButtonElement>('button[aria-label="More"]'));
  await click(menuItem("Copy"));

  expect(copiedText).toBe("Answer text");
  await click(document.querySelector<HTMLButtonElement>('button[aria-label="More"]'));
  expect(menuItem("Copied")).toBeTruthy();
});

it("offers the message for manual copying when copying fails", async () => {
  stubExecCommand(() => false);
  await click(document.querySelector<HTMLButtonElement>('button[aria-label="More"]'));
  await click(menuItem("Copy"));
  const field = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea');
  expect(field?.value).toBe("Answer text");
  await vi.waitFor(() => expect(document.activeElement).toBe(field));
});
