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
    setDropTarget: vi.fn(),
    release: vi.fn().mockResolvedValue(undefined),
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
  const removeFirst = addDropTarget("chat", first);
  const removeSecond = addDropTarget("other", second);
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

it("ignores drops without the native module", () => {
  vi.mocked(requireOptionalNativeModule).mockReturnValue(null);
  const remove = addDropTarget("chat", vi.fn());
  expect(listeners.size).toBe(0);
  remove();
});

it("syncs limits without changing target priority", () => {
  const native = requireOptionalNativeModule("RakazoFileDrop") as {
    setDropTarget: ReturnType<typeof vi.fn>;
  };
  const first = addDropTarget("chat", vi.fn(), { enabled: true, maxBytes: 100, maxFiles: 2 });
  const handler = vi.fn();
  const second = addDropTarget("chat", handler, { enabled: false, maxBytes: 50, maxFiles: 1 });
  first.update({ enabled: true, maxBytes: 90, maxFiles: 2 });
  expect(native.setDropTarget).toHaveBeenLastCalledWith(false, 50, 1);
  startDrop();
  drop({ files: [] });
  expect(handler).not.toHaveBeenCalled();
  second();
  expect(native.setDropTarget).toHaveBeenLastCalledWith(true, 90, 2);
  first();
});
it("keeps a mounted owner when another chat opens", () => {
  const owner = vi.fn();
  const remove = addDropTarget("chat", owner);
  startDrop();
  const other = vi.fn();
  const removeOther = addDropTarget("other", other);
  drop({ files: [{ name: "huge.png", mimeType: "image/png", size: 101 }] });
  expect(owner).toHaveBeenCalledOnce();
  expect(other).not.toHaveBeenCalled();
  removeOther();
  remove();
});

it("releases a pending drop after the last target leaves", () => {
  const handler = vi.fn();
  const remove = addDropTarget("chat", handler);
  startDrop();
  remove();
  drop({ files: [{ uri: "file:///fake/copy", name: "a.png", mimeType: "image/png", size: 1 }] });
  expect(handler).not.toHaveBeenCalled();
  expect(
    (requireOptionalNativeModule("RakazoFileDrop") as { release: unknown }).release,
  ).toHaveBeenCalledWith("file:///fake/copy");
  expect(listeners.get("onFilesDropped")?.size).toBe(0);
});

it("delivers to the newest registration for the owner's chat", () => {
  const stale = vi.fn();
  const removeStale = addDropTarget("chat", stale);
  startDrop();
  removeStale();
  const fresh = vi.fn();
  const removeFresh = addDropTarget("chat", fresh);
  const payload = { files: [], skipped: ["extra.png"] };
  drop(payload);
  expect(fresh).toHaveBeenCalledWith(payload);
  expect(stale).not.toHaveBeenCalled();
  removeFresh();
});

it("keeps queued drops separate and releases a disabled owner's copies", () => {
  const first = vi.fn();
  const removeFirst = addDropTarget("first", first);
  startDrop();
  const second = vi.fn();
  const removeSecond = addDropTarget("second", second);
  startDrop();
  removeSecond.update({ enabled: false, maxBytes: 100, maxFiles: 2 });
  drop({ files: [], skipped: ["extra.png"] });
  const files = [{ uri: "file:///fake/copy", name: "a.png", mimeType: "image/png", size: 1 }];
  drop({ files });
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  expect(
    (requireOptionalNativeModule("RakazoFileDrop") as { release: unknown }).release,
  ).toHaveBeenCalledWith(files[0]?.uri);
  removeSecond();
  removeFirst();
});

it("uses the newest matching target even when an older match is enabled", () => {
  const stale = vi.fn();
  const removeStale = addDropTarget("chat", stale);
  startDrop();
  const fresh = vi.fn();
  const removeFresh = addDropTarget("chat", fresh, { enabled: false, maxBytes: 100, maxFiles: 2 });
  const files = [{ uri: "file:///fake/copy", name: "a.png", mimeType: "image/png", size: 1 }];
  drop({ files });
  expect(stale).not.toHaveBeenCalled();
  expect(fresh).not.toHaveBeenCalled();
  expect(
    (requireOptionalNativeModule("RakazoFileDrop") as { release: unknown }).release,
  ).toHaveBeenCalledWith(files[0]?.uri);
  removeFresh();
  removeStale();
});

it("consumes empty completions without shifting the next drop's owner", () => {
  const first = vi.fn();
  const removeFirst = addDropTarget("first", first);
  startDrop();
  const second = vi.fn();
  const removeSecond = addDropTarget("second", second);
  startDrop();
  drop({ files: [] });
  drop({ files: [], skipped: ["extra.png"] });
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith({ files: [], skipped: ["extra.png"] });
  removeSecond();
  removeFirst();
});
