import { expect, it, vi } from "vitest";
import { createKeyedListeners } from "./keyed-listeners.js";

it("reaches only the listeners of the key, until they unsubscribe", () => {
  const channel = createKeyedListeners<string>();
  const mine = vi.fn();
  const other = vi.fn();
  const stop = channel.subscribe("bot:a", mine);
  channel.subscribe("bot:b", other);
  channel.emit("bot:a", "Plan lunch");
  stop();
  channel.emit("bot:a", "again");
  expect(mine).toHaveBeenCalledTimes(1);
  expect(mine).toHaveBeenCalledWith("Plan lunch");
  expect(other).not.toHaveBeenCalled();
});

it("keeps a later subscriber when an earlier unsubscribe runs again", () => {
  const channel = createKeyedListeners<string>();
  const first = vi.fn();
  const later = vi.fn();
  const stopFirst = channel.subscribe("bot:a", first);
  stopFirst();
  channel.subscribe("bot:a", later);
  stopFirst();
  channel.emit("bot:a", "Plan lunch");
  expect(first).not.toHaveBeenCalled();
  expect(later).toHaveBeenCalledWith("Plan lunch");
});

it("treats a repeated unsubscribe as a no-op while other listeners remain", () => {
  const channel = createKeyedListeners<string>();
  const stopFirst = channel.subscribe("bot:a", vi.fn());
  const kept = vi.fn();
  channel.subscribe("bot:a", kept);
  stopFirst();
  stopFirst();
  channel.emit("bot:a", "Plan lunch");
  expect(kept).toHaveBeenCalledWith("Plan lunch");
});
