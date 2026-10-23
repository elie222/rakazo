import { requireOptionalNativeModule } from "expo-modules-core";
import { beforeEach, expect, it, vi } from "vitest";
import type { addDropTarget as AddDropTarget } from "./file-drop";

vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: vi.fn() }));

type Listener = (payload: never) => void;
const listeners = new Map<string, Set<Listener>>();

function startDrop() {
  for (const listener of listeners.get("onDropStarted") ?? []) listener(undefined as never);
}

function drop(payload: unknown) {
  for (const listener of listeners.get("onFilesDropped") ?? []) listener(payload as never);
}

let addDropTarget: typeof AddDropTarget;

beforeEach(async () => {
  listeners.clear();
  vi.resetModules();
  vi.mocked(requireOptionalNativeModule).mockReturnValue({
    addListener: (event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return { remove: () => set.delete(listener) };
    },
  });
  ({ addDropTarget } = await import("./file-drop"));
});

it("sends drops to the most recently mounted chat only", () => {
  const first = vi.fn();
  const second = vi.fn();
  const removeFirst = addDropTarget("bot-1", first);
  const removeSecond = addDropTarget("bot-2", second);
  const files = [{ uri: "file:///a.png", name: "a.png", mimeType: "image/png", size: 3 }];

  startDrop();
  drop({ files });
  expect(second).toHaveBeenCalledWith({ files });
  expect(first).not.toHaveBeenCalled();

  removeSecond();
  startDrop();
  drop({ files });
  expect(first).toHaveBeenCalledWith({ files });

  removeFirst();
  expect(listeners.get("onFilesDropped")?.size).toBe(0);
});

it("keeps delivering to a chat that registered itself again while copying", () => {
  const files = [{ uri: "file:///a.png", name: "a.png", mimeType: "image/png", size: 3 }];
  const stale = vi.fn();
  const removeStale = addDropTarget("bot-1", stale);

  startDrop();
  // A render replaces the chat's callback while the native module is copying.
  removeStale();
  const fresh = vi.fn();
  const removeFresh = addDropTarget("bot-1", fresh);
  drop({ files });

  expect(fresh).toHaveBeenCalledWith({ files });
  expect(stale).not.toHaveBeenCalled();
  removeFresh();
});

it("discards a drop whose chat was left while copying", () => {
  const first = vi.fn();
  const second = vi.fn();
  const removeFirst = addDropTarget("bot-1", first);
  startDrop();

  removeFirst();
  const removeSecond = addDropTarget("bot-2", second);
  const files = [{ uri: "file:///a.png", name: "a.png", mimeType: "image/png", size: 3 }];
  drop({ files });

  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  removeSecond();
});

it("still tells the target about files the copy did not take", () => {
  const target = vi.fn();
  const remove = addDropTarget("bot-1", target);
  const tooLarge = [{ name: "film.mp4", limit: 64 * 1024 * 1024 }];

  startDrop();
  drop({ files: [], tooLarge, skipped: ["extra.png"] });
  expect(target).toHaveBeenCalledWith({ files: [], tooLarge, skipped: ["extra.png"] });

  remove();
});

it("ignores drops without the native module", () => {
  vi.mocked(requireOptionalNativeModule).mockReturnValue(null);
  const remove = addDropTarget("bot-1", vi.fn());
  expect(listeners.size).toBe(0);
  remove();
});
