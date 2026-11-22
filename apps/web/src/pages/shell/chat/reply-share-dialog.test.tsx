// @vitest-environment jsdom

import type { MessageReaction, ThreadMessage } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  replyShares: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
}));
vi.mock("../../../lib/query/rpc", () => ({
  rpc: rpcMock,
  rpcForSpace: () => rpcMock,
  createSpaceRpc: () => rpcMock,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: parts }, ...values),
  }),
}));

import { QueryUserProvider } from "../../../lib/query/query";
import { MessageHoverActions } from "./message-hover-actions";

const CANARY = "CANARY-HIDDEN-7f3a";
const reply: ThreadMessage = {
  id: "m1",
  threadId: "thread",
  seq: 2,
  role: "bot",
  createdAt: new Date().toISOString(),
  blocks: [
    { kind: "text", text: "Write to owner@example.com today." },
    { kind: "card", lines: [{ k: "key", v: CANARY }] },
    { kind: "steps", steps: [{ label: "Searched", count: 1, note: CANARY }] },
  ],
};

let root: Root;
let container: HTMLDivElement;
let copied: string[];

function render(message: ThreadMessage, shareTarget?: { botId: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value="user-1">
          <MessageHoverActions
            message={message}
            side="start"
            onReply={vi.fn()}
            onMarkUnread={vi.fn()}
            onReact={vi.fn<(message: ThreadMessage, reaction: MessageReaction) => Promise<void>>()}
            shareTarget={shareTarget}
          />
        </QueryUserProvider>
      </QueryClientProvider>,
    ),
  );
}

async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error("Missing element");
  await act(async () => element.click());
}

const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent === label,
  );
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("[data-testid='reply-share'] button")].find(
    (entry) => entry.textContent === label,
  );

async function openMore() {
  await click(document.querySelector('button[aria-label="More"]'));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  copied = [];
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (text: string) => void copied.push(text) },
    configurable: true,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, "clipboard");
  vi.resetAllMocks();
});

it("shows what will be public and makes the link only when Copy link is pressed", async () => {
  rpcMock.replyShares.create.mockResolvedValue({ shareUrl: "https://app.test/c/token" });
  render(reply, { botId: "bot-1" });
  await openMore();
  await click(menuItem("Share"));

  const dialog = document.querySelector("[data-testid='reply-share']");
  expect(dialog?.textContent).toContain("Anyone with the link can read this reply");
  const text = document.querySelector("[data-testid='reply-share-text']")?.textContent;
  expect(text).toBe("Write to [Redacted] today.");
  expect(dialog?.textContent).not.toContain(CANARY);
  expect(rpcMock.replyShares.create).not.toHaveBeenCalled();

  await click(button("Copy link"));
  await vi.waitFor(() => expect(copied).toEqual(["https://app.test/c/token"]));
  expect(rpcMock.replyShares.create).toHaveBeenCalledWith({ botId: "bot-1", messageId: "m1" });
  await vi.waitFor(() => expect(button("Copied")).toBeDefined());

  // Copying again copies the same link rather than making another.
  await click(button("Copied"));
  await vi.waitFor(() => expect(copied).toHaveLength(2));
  expect(rpcMock.replyShares.create).toHaveBeenCalledTimes(1);
});

it("says when the link could not be made", async () => {
  rpcMock.replyShares.create.mockRejectedValue(new Error("offline"));
  render(reply, { botId: "bot-1" });
  await openMore();
  await click(menuItem("Share"));
  await click(button("Copy link"));
  await vi.waitFor(() =>
    expect(document.querySelector("[data-testid='reply-share'] [role='alert']")).not.toBeNull(),
  );
  expect(copied).toEqual([]);
});

it("offers Share only on a bot reply with text in a chat", async () => {
  render({ ...reply, role: "user" }, { botId: "bot-1" });
  await openMore();
  expect(menuItem("Copy")).toBeDefined();
  expect(menuItem("Share")).toBeUndefined();
  await click(document.querySelector('button[aria-label="More"]'));

  render(reply);
  await openMore();
  expect(menuItem("Share")).toBeUndefined();
});
