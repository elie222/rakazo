import { requireOptionalNativeModule } from "expo-modules-core";
import { beforeEach, expect, it, vi } from "vitest";
import { addDropTarget } from "./file-drop";

vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: vi.fn() }));

type Listener = (payload: never) => void;
const listeners = new Map<string, Set<Listener>>();

function startDrop() {
  for (const listener of listeners.get("onDropStarted") ?? []) listener(undefined as never);
}

function drop(payload: unknown) {
  for (const listener of listeners.get("onFilesDropped") ?? []) listener(payload as never);
}

beforeEach(() => {
  listeners.clear();
  vi.mocked(requireOptionalNativeModule).mockReturnValue({
    addListener: (event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return { remove: () => set.delete(listener) };
    },
  });
});

it("sends drops to the most recently mounted target only", () => {
  const first = vi.fn();
  const second = vi.fn();
  const removeFirst = addDropTarget(first);
  const removeSecond = addDropTarget(second);
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

it("keeps a drop with the chat that was open when it started", () => {
  const first = vi.fn();
  const second = vi.fn();
  const removeFirst = addDropTarget(first);
  const removeSecond = addDropTarget(second);
  const files = [{ uri: "file:///a.png", name: "a.png", mimeType: "image/png", size: 3 }];

  // The files were dropped over the first chat, and the second opened while the
  // native module was still copying them.
  startDrop();
  removeFirst();
  removeSecond();
  const removeThird = addDropTarget(first);
  drop({ files });

  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  removeThird();
});

it("still tells the target about files the guard refused to copy", () => {
  const target = vi.fn();
  const remove = addDropTarget(target);
  const tooLarge = [{ name: "film.mp4", limit: 64 * 1024 * 1024 }];

  startDrop();
  drop({ files: [], tooLarge });
  expect(target).toHaveBeenCalledWith({ files: [], tooLarge });

  remove();
});

it("ignores drops without the native module", () => {
  vi.mocked(requireOptionalNativeModule).mockReturnValue(null);
  const remove = addDropTarget(vi.fn());
  expect(listeners.size).toBe(0);
  remove();
});
