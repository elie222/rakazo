// @vitest-environment jsdom

import type { ThreadMessage } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useReplyAnnouncement } from "./use-reply-announcement";

const message = (
  seq: number,
  text: string,
  role: ThreadMessage["role"] = "bot",
  id = `m-${seq}`,
): ThreadMessage => ({
  id,
  threadId: "fixture-thread",
  seq,
  role,
  blocks: [{ kind: "text", text }],
  createdAt: "2026-01-01T00:00:00.000Z",
});

function Status({ messages }: { messages: ThreadMessage[] }) {
  const announcement = useReplyAnnouncement(messages, () => "Sample Bot");
  return <span role="status">{announcement}</span>;
}

let container: HTMLDivElement;
let root: Root;

async function render(messages: ThreadMessage[], thread = "first-thread") {
  await act(async () => root.render(<Status key={thread} messages={messages} />));
}

function live() {
  const status = container.querySelector('[role="status"]');
  if (!status) throw new Error("Missing mounted reply status");
  return status;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("clears and republishes identical completed replies in the same live region", async () => {
  const history = message(2, "Old reply.");
  await render([history]);
  const status = live();
  expect(status.textContent).toBe("");

  const first = message(3, "Done.");
  await render([history, first]);
  expect(status.textContent).toBe("Sample Bot: Done.");
  const changes: string[] = [];
  const observer = new MutationObserver(() => changes.push(status.textContent ?? ""));
  observer.observe(status, { childList: true, characterData: true, subtree: true });
  try {
    const own = message(4, "Again, please.", "user");
    const progress = message(99, "Still working.", "bot", "progress:fixture");
    await render([message(1, "Earlier history."), history, first, own, progress]);
    expect(changes).toEqual([]);

    await render([history, first, own, message(5, "Done.")]);
    expect(live()).toBe(status);
    expect(status.textContent).toBe("");
    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(status.textContent).toBe("Sample Bot: Done.");
    expect(changes).toEqual(["", "Sample Bot: Done."]);
  } finally {
    observer.disconnect();
  }
});

it("does not let a pending repeat replace a newer different reply", async () => {
  await render([]);
  const first = message(1, "Done.");
  await render([first]);
  const second = message(2, "Done.");
  await render([first, second]);
  expect(live().textContent).toBe("");

  await render([first, second, message(3, "New update.")]);
  expect(live().textContent).toBe("Sample Bot: New update.");
  await act(async () => vi.runOnlyPendingTimersAsync());
  expect(live().textContent).toBe("Sample Bot: New update.");
});

it("discards a pending repeat when the transcript remounts for another thread", async () => {
  await render([]);
  const previousStatus = live();
  const first = message(1, "Done.");
  await render([first]);
  await render([first, message(2, "Done.")]);
  expect(previousStatus.textContent).toBe("");

  const history = message(10, "Other thread's existing reply.");
  await render([history], "other-thread");
  expect(live()).not.toBe(previousStatus);
  await act(async () => vi.runOnlyPendingTimersAsync());
  expect(live().textContent).toBe("");
  expect(previousStatus.textContent).toBe("");

  await render([history, message(11, "New reply.")], "other-thread");
  expect(live().textContent).toBe("Sample Bot: New reply.");
});
