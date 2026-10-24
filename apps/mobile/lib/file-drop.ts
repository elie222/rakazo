import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import { requireOptionalNativeModule } from "expo-modules-core";

export type DroppedFile = { uri?: string; name: string; mimeType: string; size: number };
export type DropPayload = { files: DroppedFile[]; skipped?: string[] };

export type DropLimits = { enabled: boolean; maxBytes: number; maxFiles: number };
type FileDropModule = {
  setDropTarget(enabled: boolean, maxBytes: number, maxFiles: number): void;
  release(uri: string): Promise<void>;
  addListener(event: "onFilesDropped", listener: (event: DropPayload) => void): { remove(): void };
  addListener(event: "onDropStarted", listener: () => void): { remove(): void };
};

// Android only: absent on iOS, on web, and in binaries built before the module existed.
function nativeFileDrop(): FileDropModule | null {
  return requireOptionalNativeModule<FileDropModule>("RakazoFileDrop");
}

export async function releaseDroppedFile(uri: string): Promise<void> {
  await nativeFileDrop()?.release(uri);
}
type DropTarget = { key: string; handler: (payload: DropPayload) => void; limits: DropLimits };
function syncTarget() {
  const limits = targets.at(-1)?.limits ?? {
    enabled: false,
    maxBytes: ATTACHMENT_MAX_BYTES,
    maxFiles: ATTACHMENT_MAX_COUNT,
  };
  nativeFileDrop()?.setDropTarget(limits.enabled, limits.maxBytes, limits.maxFiles);
}

// One window, one drop target: the most recently mounted screen receives drops.
const targets: DropTarget[] = [];
// The chat key for each started drop, in native copy order. Copying takes a
// while, so the chat the files were dropped over owns them even if another chat
// is opened before they arrive.
const pending: Array<string | null> = [];
let listeners: Array<{ remove(): void }> = [];

function attach(): void {
  const native = nativeFileDrop();
  if (!native || listeners.length) return;
  listeners = [
    native.addListener("onDropStarted", () => {
      const target = targets.at(-1);
      pending.push(target?.limits.enabled ? target.key : null);
    }),
    native.addListener("onFilesDropped", (payload) => {
      const key = pending.shift();
      const owner = key == null ? undefined : targets.findLast((target) => target.key === key);
      // A drop whose chat is gone is discarded rather than handed to another chat.
      if (!owner?.limits.enabled) {
        for (const file of payload.files) {
          if (file.uri) void releaseDroppedFile(file.uri).catch(() => {});
        }
      } else if (payload.files.length > 0 || payload.skipped?.length) owner.handler(payload);
      if (!targets.length && !pending.length) detach();
    }),
  ];
}

function detach(): void {
  for (const listener of listeners) listener.remove();
  listeners = [];
}

/** The latest focused target owns routing, including when disabled. */
export function addDropTarget(
  key: string,
  handler: (payload: DropPayload) => void,
  limits: DropLimits = {
    enabled: true,
    maxBytes: ATTACHMENT_MAX_BYTES,
    maxFiles: ATTACHMENT_MAX_COUNT,
  },
): (() => void) & { update(limits: DropLimits): void } {
  const target = { key, handler, limits };
  targets.push(target);
  attach();
  syncTarget();
  return Object.assign(
    () => {
      const index = targets.indexOf(target);
      if (index >= 0) targets.splice(index, 1);
      syncTarget();
      if (!targets.length && !pending.length) detach();
    },
    {
      update(next: DropLimits) {
        target.limits = next;
        syncTarget();
      },
    },
  );
}
