// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageView } from "./message-view";

vi.mock("../../lib/rpc", () => ({ rpc: { artifacts: { get: vi.fn() } } }));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const ana = { id: "user-a", name: "Ana" };

function render(message: ThreadMessage, meId = "user-b") {
  act(() =>
    root.render(
      <MessageView
        artifactTarget={{ botId: "bot" }}
        canAnswer={false}
        canDismiss={false}
        message={message}
        meId={meId}
        onAnswer={vi.fn()}
        onMarkUnread={vi.fn()}
        onOpenBot={vi.fn()}
        onOpenPeerMessages={vi.fn()}
        onTogglePeerReplies={vi.fn()}
        peerBot={() => undefined}
        onRefresh={vi.fn()}
        onBotChanged={vi.fn()}
        onAddRoutine={vi.fn()}
        voiceReady={false}
        speaking={false}
        onSpeak={vi.fn()}
        onOpenComputer={vi.fn()}
        showToolActivity={false}
        onReply={vi.fn()}
        onReact={vi.fn()}
      />,
    ),
  );
  const bubble = container.querySelector<HTMLElement>('[data-testid="message-user-bubble"]');
  if (!bubble?.parentElement) throw new Error("user bubble missing");
  return { bubble, row: bubble.parentElement };
}

const message: ThreadMessage = {
  id: "message",
  threadId: "thread",
  seq: 1,
  role: "user",
  author: ana,
  blocks: [{ kind: "text", text: "Book the table" }],
  createdAt: new Date().toISOString(),
};

it("names someone else's message and keeps it on the people side", () => {
  const { bubble, row } = render(message);

  expect(container.textContent).toBe("AnaBook the table");
  expect(row.className).toContain("justify-end");
  expect(bubble.className).toContain("bg-muted");
  expect(bubble.className).not.toContain("bg-chat-user");
});

it("keeps my own message unnamed on the right", () => {
  const { bubble, row } = render(message, ana.id);

  expect(container.textContent).toBe("Book the table");
  expect(row.className).toContain("justify-end");
  expect(bubble.className).toContain("bg-chat-user");
});

it("names the person a reply quotes instead of saying You", () => {
  render(
    {
      ...message,
      author: undefined,
      replyToMessageId: "parent",
      replyPreview: { role: "user", author: ana, text: "Find us a restaurant" },
    },
    "user-b",
  );

  expect(container.querySelector('[data-testid="reply-parent-preview"]')?.textContent).toContain(
    "Ana: Find us a restaurant",
  );
});
