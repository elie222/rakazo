import { requireOptionalNativeModule } from "expo-modules-core";
import { beforeEach, expect, it, vi } from "vitest";
import { addDropTarget } from "./file-drop";

vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: vi.fn() }));

type Listener = (payload: never) => void;
let listeners: Set<Listener>;

function drop(payload: unknown) {
  for (const listener of listeners) listener(payload as never);
}

beforeEach(() => {
  listeners = new Set();
  vi.mocked(requireOptionalNativeModule).mockReturnValue({
    addListener: (_event: string, listener: Listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  });
});

it("sends drops to the most recently mounted target only", () => {
  const first = vi.fn();
  const second = vi.fn();
  const removeFirst = addDropTarget(first);
  const removeSecond = addDropTarget(second);
  const files = [{ uri: "file:///a.png", name: "a.png", mimeType: "image/png", size: 3 }];

  drop({ files });
  expect(second).toHaveBeenCalledWith({ files });
  expect(first).not.toHaveBeenCalled();

  removeSecond();
  drop({ files });
  expect(first).toHaveBeenCalledWith({ files });

  removeFirst();
  expect(listeners.size).toBe(0);
});

it("still tells the target about files the guard refused to copy", () => {
  const target = vi.fn();
  const remove = addDropTarget(target);
  const tooLarge = [{ name: "film.mp4", limit: 64 * 1024 * 1024 }];

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
