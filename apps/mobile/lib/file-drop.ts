import { requireOptionalNativeModule } from "expo-modules-core";

export type DroppedFile = { uri: string; name: string; mimeType: string; size: number };

/** A file the native module refused to copy, with the guard it crossed. */
export type RefusedDrop = { name: string; limit: number };

export type DropPayload = {
  files: DroppedFile[];
  tooLarge?: RefusedDrop[];
  /** Files the native copy skipped once it had taken enough for one drop. */
  skipped?: string[];
};

type FileDropModule = {
  addListener(event: "onFilesDropped", listener: (event: DropPayload) => void): { remove(): void };
  addListener(event: "onDropStarted", listener: () => void): { remove(): void };
};

// Android only: absent on iOS, on web, and in binaries built before the module existed.
function nativeFileDrop(): FileDropModule | null {
  return requireOptionalNativeModule<FileDropModule>("RakazoFileDrop");
}

type DropTarget = { key: string; deliver: (payload: DropPayload) => void };

// One window, one drop target: the most recently mounted screen receives drops.
const targets: DropTarget[] = [];
// The chat that was on screen when the current drop started. Copying takes a
// while, so the chat the files were dropped over owns them even if another one
// is opened before they arrive.
let ownerKey: string | null = null;
let listeners: Array<{ remove(): void }> = [];

function attach(): void {
  const native = nativeFileDrop();
  if (!native || listeners.length) return;
  listeners = [
    native.addListener("onDropStarted", () => {
      ownerKey = targets.at(-1)?.key ?? null;
    }),
    native.addListener("onFilesDropped", (payload) => {
      const owner = ownerKey;
      ownerKey = null;
      // A re-render registers the same chat again, so the newest entry for that
      // chat delivers; a chat that is no longer open drops the files instead.
      const target = owner === null ? undefined : targets.filter((it) => it.key === owner).at(-1);
      if (!target) return;
      if (payload.files.length > 0 || payload.tooLarge?.length || payload.skipped?.length)
        target.deliver(payload);
    }),
  ];
}

function detach(): void {
  for (const listener of listeners) listener.remove();
  listeners = [];
}

/**
 * Registers a drop target for one chat and returns its unregister function.
 * The key identifies the chat, so re-registering after a render keeps the chat's
 * claim on a drop that is still being copied.
 */
export function addDropTarget(key: string, deliver: (payload: DropPayload) => void): () => void {
  const target: DropTarget = { key, deliver };
  targets.push(target);
  attach();
  return () => {
    const index = targets.lastIndexOf(target);
    if (index >= 0) targets.splice(index, 1);
    if (targets.length === 0) detach();
  };
}
