// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerReplyPreview, ReplyLine, TimeSeparator } from "./chat-context";

vi.mock("@lingui/react/macro", () => ({
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
const message: ThreadMessage = {
  id: "reply",
  threadId: "thread",
  seq: 1,
  role: "user",
  createdAt: new Date().toISOString(),
  blocks: [],
  replyToMessageId: "parent",
  replyPreview: { role: "bot", botId: "bot", text: "First line\nSecond line" },
};
it("renders an unselectable semantic separator", () => {
  act(() =>
    root.render(
      <TimeSeparator createdAt={new Date(2026, 9, 6, 16, 5).toISOString()} locale="en-US" />,
    ),
  );
  expect(container.querySelector("h3")?.textContent).toContain("4:05 PM");
  expect(container.querySelector("h3")?.className).toContain("select-none");
});
it("shows a compact composer quote and dismisses it", () => {
  const onDismiss = vi.fn();
  act(() =>
    root.render(
      <ComposerReplyPreview
        author="Helper"
        text={"First line\nSecond line"}
        onDismiss={onDismiss}
      />,
    ),
  );
  expect(container.textContent).toBe("Helper: First line");
  act(() => container.querySelector("button")!.click());
  expect(onDismiss).toHaveBeenCalledOnce();
});
it("navigates a one-line authoritative quote without a loaded parent", () => {
  const onJump = vi.fn();
  act(() => root.render(<ReplyLine message={message} author="Helper" onJump={onJump} />));
  expect(container.textContent).toBe("↩ Helper: First line");
  act(() => container.querySelector("button")!.click());
  expect(onJump).toHaveBeenCalledWith("parent");
});
it("renders a deleted target as static unavailable text", () => {
  act(() =>
    root.render(
      <ReplyLine
        message={{
          ...message,
          replyToMessageId: undefined,
          replyQuote: "Old text",
          replyPreview: null,
        }}
        author="Helper"
      />,
    ),
  );
  expect(container.textContent).toBe("Original message unavailable");
  expect(container.querySelector("button")).toBeNull();
});

it("dismisses a composer reply with Escape", () => {
  const onDismiss = vi.fn();
  act(() =>
    root.render(<ComposerReplyPreview author="Helper" text="Quote" onDismiss={onDismiss} />),
  );
  act(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })),
  );
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("keeps internal peer receipt replies out of the transcript", () => {
  act(() =>
    root.render(
      <ReplyLine
        message={{
          ...message,
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "peer",
              fromBotName: "Researcher",
              text: "peer response",
              hop: 1,
            },
          ],
          replyPreview: { role: "bot", botId: "bot", text: "peer-exchange-alpha" },
        }}
        author="Bot"
      />,
    ),
  );
  expect(container.textContent).toBe("");
});
