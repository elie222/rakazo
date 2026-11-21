// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEnteringMessages } from "./use-entering-messages";

function message(id: string, seq: number, role: ThreadMessage["role"] = "bot"): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq,
    role,
    blocks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as ThreadMessage;
}

/** A live row (progress, tool step or subagent) carries no message seq. */
function liveMessage(id: string): ThreadMessage {
  const { seq: _seq, ...rest } = message(id, 0);
  return rest as unknown as ThreadMessage;
}

let root: Root;
let container: HTMLDivElement;
let latest: ReadonlySet<string>;

function Probe({ messages }: { messages: readonly ThreadMessage[] }) {
  latest = useEnteringMessages(messages);
  return null;
}

async function show(messages: readonly ThreadMessage[]) {
  await act(async () => root.render(<Probe messages={messages} />));
  return latest;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  latest = new Set();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useEnteringMessages", () => {
  it("marks a reply that lands after the first paint", async () => {
    const history = [message("m1", 1)];
    await expect(show(history)).resolves.toEqual(new Set());
    await expect(show([...history, message("m2", 2)])).resolves.toEqual(new Set(["m2"]));
  });

  it("leaves history and older pages still", async () => {
    const history = [message("m1", 1), message("m2", 2)];
    await show(history);
    await expect(show([message("m0", 0), ...history])).resolves.toEqual(new Set());
  });

  it("never pops the streaming progress row", async () => {
    await show([message("m1", 1)]);
    await expect(show([message("m1", 1), message("progress:bot-1", 2)])).resolves.toEqual(
      new Set(),
    );
  });

  it("keeps the high-water mark numeric when a live row has no seq", async () => {
    await show([message("m1", 1)]);
    await expect(
      show([message("m1", 1), liveMessage("subagent:bot-1"), message("m2", 2)]),
    ).resolves.toEqual(new Set(["m2"]));
  });

  it("keeps an earlier reply marked while a later one lands", async () => {
    await show([message("m1", 1)]);
    await show([message("m1", 1), message("m2", 2)]);
    await expect(show([message("m1", 1), message("m2", 2), message("m3", 3)])).resolves.toEqual(
      new Set(["m2", "m3"]),
    );
  });

  it("clears the mark once the entrance has played", async () => {
    vi.useFakeTimers();
    await show([message("m1", 1)]);
    await show([message("m1", 1), message("m2", 2)]);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(latest).toEqual(new Set());
  });
});
