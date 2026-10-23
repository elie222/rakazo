import { requireOptionalNativeModule } from "expo-modules-core";
import { useEffect, useRef } from "react";

export type DroppedFile = { uri: string; name: string; mimeType: string; size: number };

type FileDropModule = {
  addListener(
    event: "onFilesDropped",
    listener: (event: { files: DroppedFile[] }) => void,
  ): { remove(): void };
};

// Android only: absent on iOS, on web, and in binaries built before the module existed.
function nativeFileDrop(): FileDropModule | null {
  return requireOptionalNativeModule<FileDropModule>("RakazoFileDrop");
}

// One window, one drop target: the most recently mounted screen receives drops.
const targets: Array<(files: DroppedFile[]) => void> = [];
let subscription: { remove(): void } | null = null;

/** Registers a drop target and returns its unregister function. */
export function addDropTarget(target: (files: DroppedFile[]) => void): () => void {
  targets.push(target);
  subscription ??=
    nativeFileDrop()?.addListener("onFilesDropped", ({ files }) => {
      if (files.length > 0) targets.at(-1)?.(files);
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

/** Receives files dragged onto the app from another window while mounted. */
export function useFileDrop(handler: (files: DroppedFile[]) => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => addDropTarget((files) => latest.current(files)), []);
}
