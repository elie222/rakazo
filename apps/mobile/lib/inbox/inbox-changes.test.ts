import { expect, it, vi } from "vitest";
import { onOpenChatFromInbox, openChatFromInbox } from "./inbox-changes";

it("opens a chat through the mounted inbox, and reports when none is mounted", () => {
  const href = { pathname: "/thread", params: { botId: "bot-1" } } as const;
  expect(openChatFromInbox(href)).toBe(false);
  const open = vi.fn();
  const stop = onOpenChatFromInbox(open);
  expect(openChatFromInbox(href)).toBe(true);
  expect(open).toHaveBeenCalledWith(href);
  stop();
  expect(openChatFromInbox(href)).toBe(false);
});
