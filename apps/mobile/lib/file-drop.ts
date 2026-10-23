import { requireOptionalNativeModule } from "expo-modules-core";

export type DroppedFile = { uri: string; name: string; mimeType: string; size: number };

/** A file the native module refused to copy, with the guard it crossed. */
export type RefusedDrop = { name: string; limit: number };

export type DropPayload = { files: DroppedFile[]; tooLarge?: RefusedDrop[] };

type FileDropModule = {
  addListener(event: "onFilesDropped", listener: (event: DropPayload) => void): { remove(): void };
  addListener(event: "onDropStarted", listener: () => void): { remove(): void };
};

// Android only: absent on iOS, on web, and in binaries built before the module existed.
function nativeFileDrop(): FileDropModule | null {
  return requireOptionalNativeModule<FileDropModule>("RakazoFileDrop");
}

type DropTarget = (payload: DropPayload) => void;

// One window, one drop target: the most recently mounted screen receives drops.
const targets: DropTarget[] = [];
// The target that was on screen when the current drop started. Copying takes a
// while, so the chat the files were dropped over owns them even if another chat
// is opened before they arrive.
let dropTarget: DropTarget | null = null;
let listeners: Array<{ remove(): void }> = [];

function attach(): void {
  const native = nativeFileDrop();
  if (!native || listeners.length) return;
  listeners = [
    native.addListener("onDropStarted", () => {
      dropTarget = targets.at(-1) ?? null;
    }),
    native.addListener("onFilesDropped", (payload) => {
      const owner = dropTarget;
      dropTarget = null;
      // A drop whose chat is gone is discarded rather than handed to another chat.
      if (!owner || !targets.includes(owner)) return;
      if (payload.files.length > 0 || payload.tooLarge?.length) owner(payload);
    }),
  ];
}

function detach(): void {
  for (const listener of listeners) listener.remove();
  listeners = [];
  dropTarget = null;
}

/** Registers a drop target and returns its unregister function. */
export function addDropTarget(target: DropTarget): () => void {
  targets.push(target);
  attach();
  return () => {
    const index = targets.lastIndexOf(target);
    if (index >= 0) targets.splice(index, 1);
    if (dropTarget === target) dropTarget = null;
    if (targets.length === 0) detach();
  };
}
