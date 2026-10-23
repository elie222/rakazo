import { requireOptionalNativeModule } from "expo-modules-core";

export type DroppedFile = { uri: string; name: string; mimeType: string; size: number };

/** Files the native module refused to copy because they passed its storage guard. */
export type DropPayload = { files: DroppedFile[]; tooLarge?: string[] };

type FileDropModule = {
  addListener(event: "onFilesDropped", listener: (event: DropPayload) => void): { remove(): void };
};

// Android only: absent on iOS, on web, and in binaries built before the module existed.
function nativeFileDrop(): FileDropModule | null {
  return requireOptionalNativeModule<FileDropModule>("RakazoFileDrop");
}

// One window, one drop target: the most recently mounted screen receives drops.
const targets: Array<(payload: DropPayload) => void> = [];
let subscription: { remove(): void } | null = null;

/** Registers a drop target and returns its unregister function. */
export function addDropTarget(target: (payload: DropPayload) => void): () => void {
  targets.push(target);
  subscription ??=
    nativeFileDrop()?.addListener("onFilesDropped", (payload) => {
      if (payload.files.length > 0 || payload.tooLarge?.length) targets.at(-1)?.(payload);
    }) ?? null;
  return () => {
    const index = targets.lastIndexOf(target);
    if (index >= 0) targets.splice(index, 1);
    if (targets.length === 0) {
      subscription?.remove();
      subscription = null;
    }
  };
}
