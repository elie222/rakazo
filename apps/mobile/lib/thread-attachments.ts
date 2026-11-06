import type { MenuAction } from "@expo/ui/community/menu";
import { attachmentMaxBytes, attachmentMaxCount } from "@rakazo/contracts";
import { attachmentsForThread } from "@rakazo/core";
import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThreadComposerHandle } from "../components/thread-composer";
import type { ComposerDraftScope } from "./composer-draft";
import { t, useI18n } from "./i18n";
import {
  isIncomingShareCurrent,
  releaseIncomingShareFiles,
  retryIncomingShare,
  takeIncomingShare,
} from "./incoming-share";
import type { PickedAttachment } from "./pick-attachments";
import {
  pickDocuments,
  pickFromLibrary,
  readDroppedFiles,
  readSharedFiles,
  takePhoto,
} from "./pick-attachments";
import { attachmentCountSkipReason } from "./pick-attachments-filter";
import { registerSessionDiskCache } from "./session";
import { useFileDrop } from "./use-file-drop";
import { errorText } from "./user-error";

export type PendingAttachment = PickedAttachment & { threadKey: string };

/** Retained drafts for inactive chats stay within this many full messages' worth of bytes;
 * past that the least recently saved chat's draft is dropped, releasing its share copies. */
const RETAINED_DRAFT_BUDGET_MESSAGES = 2;

function retainedScopeKey(scope: ComposerDraftScope): string {
  return `${scope.apiBase}\n${scope.userId}\n${scope.threadKey}`;
}

/** A chat's unsent attachments, kept while its screen is away so leaving without sending does
 * not lose them. The text draft persists on disk; attachment bytes do not fit that file. */
const retainedDraftAttachments = new Map<string, PendingAttachment[]>();

/** The iOS share copy an imported attachment came from, released only when that attachment is
 * sent or removed. Until then an unsent share is never without its file. */
const retainedShareCopies = new Map<string, string>();

function releaseShareCopy(uri: string) {
  releaseIncomingShareFiles([{ uri, name: "", mimeType: null }]);
}

function retainedDraftBytes(list: readonly PendingAttachment[]): number {
  let total = 0;
  for (const item of list) total += Math.floor((item.contentBase64.length * 3) / 4);
  return total;
}

/** Every session change (sign-in, sign-out, server switch) deletes retained drafts and their
 * share copies, so another account inherits none of them. */
function clearRetainedAttachments() {
  retainedDraftAttachments.clear();
  for (const [id, uri] of retainedShareCopies) {
    retainedShareCopies.delete(id);
    releaseShareCopy(uri);
  }
}
registerSessionDiskCache(clearRetainedAttachments);

function formatAttachmentSkip(item: { name: string; reason: string }): string {
  const name = item.name === "camera" ? t("Camera") : item.name;
  if (item.reason === "permission denied") return t("{name} (permission denied)", { name });
  if (item.reason.startsWith("over "))
    return t("{name} (over {limit})", { name, limit: item.reason.slice(5) });
  if (item.reason === "unsupported type") return t("{name} (unsupported type)", { name });
  const maxMatch = /^max (\d+) attachments$/.exec(item.reason);
  if (maxMatch) {
    return t("{name} (max {count} attachments)", { name, count: maxMatch[1] ?? "" });
  }
  return `${name} (${t(item.reason)})`;
}

/** The composer's draft attachments, kept per chat, from the picker menu or a file drop. */
export function useThreadAttachments({
  botId,
  groupId,
  readOnly,
  uploadConfig,
  draftScope,
}: {
  botId?: string;
  groupId?: string;
  readOnly: boolean;
  uploadConfig?: { maxUploadSizeBytes?: number; maxAttachmentsPerMessage?: number };
  /** The chat's draft key; unsent attachments stay under it between visits to the chat. */
  draftScope?: ComposerDraftScope;
}) {
  const { t } = useI18n();
  const threadKey = groupId ?? botId;
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>(() =>
    draftScope ? (retainedDraftAttachments.get(retainedScopeKey(draftScope)) ?? []) : [],
  );
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const activePendingAttachments = attachmentsForThread(pendingAttachments, threadKey);
  // Read by a second drop that starts before the first one commits.
  const pendingAttachmentsRef = useRef(pendingAttachments);
  pendingAttachmentsRef.current = pendingAttachments;
  const importingShare = useRef(false);
  const [shareImporting, setShareImporting] = useState(false);
  // The chat whose draft this state holds; a warm link to another chat reuses the screen, so
  // the state swaps to that chat's draft instead of writing this chat's over it.
  const liveScopeKey = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const key = draftScope ? retainedScopeKey(draftScope) : null;
    if (liveScopeKey.current !== key) {
      liveScopeKey.current = key;
      if (key !== null) setPendingAttachments(retainedDraftAttachments.get(key) ?? []);
      return;
    }
    if (key !== null) {
      // Re-save at the end, so the bound below drops the oldest chats' drafts first.
      retainedDraftAttachments.delete(key);
      if (pendingAttachments.length) retainedDraftAttachments.set(key, pendingAttachments);
      const budget =
        RETAINED_DRAFT_BUDGET_MESSAGES *
        attachmentMaxBytes(uploadConfig) *
        attachmentMaxCount(uploadConfig);
      let total = 0;
      for (const list of retainedDraftAttachments.values()) total += retainedDraftBytes(list);
      for (const [oldest, list] of retainedDraftAttachments) {
        // This chat's own draft never goes; only the inactive chats' do.
        if (total <= budget || oldest === key) break;
        retainedDraftAttachments.delete(oldest);
        total -= retainedDraftBytes(list);
      }
    }
    // A share copy goes only once its attachment does: sent, removed, or dropped for another chat.
    const unsent = new Set(pendingAttachments.map((item) => item.id));
    for (const list of retainedDraftAttachments.values())
      for (const item of list) unsent.add(item.id);
    for (const [id, uri] of retainedShareCopies) {
      if (unsent.has(id)) continue;
      retainedShareCopies.delete(id);
      releaseShareCopy(uri);
    }
  }, [pendingAttachments, draftScope, uploadConfig]);

  const attachActions: MenuAction[] = [
    { id: "library", title: t("Photo library"), image: "photo.on.rectangle" },
    { id: "camera", title: t("Camera"), image: "camera" },
    { id: "file", title: t("File"), image: "doc" },
  ];

  function attachFrom(source: string) {
    if (importingShare.current) return;
    if (source === "library") void addAttachments(pickFromLibrary);
    else if (source === "camera") void addAttachments(takePhoto);
    else if (source === "file") void addAttachments(pickDocuments);
  }

  async function addAttachments(
    picker: (
      existingCount: number,
      maxBytes: number,
      maxCount: number,
    ) => Promise<{
      attachments: PickedAttachment[];
      skipped: Array<{ name: string; reason: string }>;
    }>,
  ) {
    const targetKey = groupId ?? botId;
    if (!targetKey) return;
    let result: Awaited<ReturnType<typeof picker>>;
    try {
      result = await picker(
        activePendingAttachments.length,
        attachmentMaxBytes(uploadConfig),
        attachmentMaxCount(uploadConfig),
      );
    } catch (error) {
      // A picker that fails to open reports it instead of rejecting unhandled.
      setAttachmentNotice(errorText(error, t("Could not attach files")));
      return;
    }
    if ((groupId ?? botId) !== targetKey) return;
    // Two drops can overlap, so the room left is settled against the draft as it
    // is now, not as it was when this read began.
    const room = Math.max(
      0,
      attachmentMaxCount(uploadConfig) -
        attachmentsForThread(pendingAttachmentsRef.current, targetKey).length,
    );
    const accepted = result.attachments
      .slice(0, room)
      .map((attachment) => ({ ...attachment, threadKey: targetKey }));
    if (accepted.length) {
      // The ref moves now, not only at the next render, so another read that settles
      // before that render sees the room this one has already taken.
      pendingAttachmentsRef.current = [...pendingAttachmentsRef.current, ...accepted];
      setPendingAttachments((current) => [...current, ...accepted]);
    }
    const skipped = [
      ...result.skipped,
      ...result.attachments.slice(room).map((attachment) => ({
        name: attachment.name,
        reason: attachmentCountSkipReason(attachmentMaxCount(uploadConfig)),
      })),
    ];
    setAttachmentNotice(
      skipped.length
        ? t("Skipped {items}", {
            items: skipped.map((item) => formatAttachmentSkip(item)).join(", "),
          })
        : null,
    );
  }

  useFileDrop(
    threadKey ?? null,
    ({ files, skipped }) => {
      void addAttachments((count, maxBytes, maxCount) =>
        readDroppedFiles(files, count, maxBytes, skipped, maxCount),
      );
    },
    {
      enabled: !readOnly && Boolean(groupId ?? botId),
      maxBytes: attachmentMaxBytes(uploadConfig),
      maxFiles: attachmentMaxCount(uploadConfig),
    },
  );

  return {
    pendingAttachments,
    pendingAttachmentsRef,
    setPendingAttachments,
    activePendingAttachments,
    attachmentNotice,
    setAttachmentNotice,
    attachActions,
    attachFrom,
    importingShare,
    shareImporting,
    setShareImporting,
  };
}

/** Takes an incoming share into this chat once its upload limits are known. */
export function useIncomingShareImport({
  attachments,
  composerRef,
  readOnly,
  threadKey,
  uploadConfig,
}: {
  attachments: ReturnType<typeof useThreadAttachments>;
  composerRef: RefObject<ThreadComposerHandle | null>;
  readOnly: boolean;
  threadKey: string | undefined;
  uploadConfig?: { maxUploadSizeBytes?: number; maxAttachmentsPerMessage?: number };
}) {
  const {
    importingShare,
    pendingAttachmentsRef,
    setShareImporting,
    setPendingAttachments,
    setAttachmentNotice,
  } = attachments;
  // The share a settings refresh interrupted. It is retried on its own, so a
  // share that arrived in the meantime is left for the picker, not taken here.
  const interruptedShare = useRef<{ generation: number } | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  // A warm link to another chat commits before this effect's cleanup runs; a read that settles
  // in between must not land in the state the new chat is about to replace. Set at commit, so a
  // render of another chat that React discards leaves the committed chat's read in place.
  const committedThread = useRef(threadKey);
  useLayoutEffect(() => {
    committedThread.current = threadKey;
  }, [threadKey]);
  useEffect(() => {
    if (!threadKey || readOnly || !uploadConfig || importingShare.current) return;
    const interrupted = interruptedShare.current;
    interruptedShare.current = null;
    const share = takeIncomingShare();
    if (!share) return;
    if (interrupted && share.generation !== interrupted.generation) {
      retryIncomingShare(share);
      return;
    }
    let active = true;
    importingShare.current = true;
    setShareImporting(true);
    void (async () => {
      try {
        const result = await readSharedFiles(
          share.files,
          attachments.activePendingAttachments.length,
          attachmentMaxBytes(uploadConfig),
          attachmentMaxCount(uploadConfig),
        );
        if (!active || committedThread.current !== threadKey || !isIncomingShareCurrent(share)) {
          retryIncomingShare(share);
          return;
        }
        if (result.failedFiles.length)
          retryIncomingShare({ ...share, text: "", files: result.failedFiles });
        // A drop or a picker opened before the import can add files while it reads, so the
        // room left is settled against the draft as it is now, as in addAttachments.
        const maxCount = attachmentMaxCount(uploadConfig);
        const room = Math.max(
          0,
          maxCount - attachmentsForThread(pendingAttachmentsRef.current, threadKey).length,
        );
        const accepted = result.attachments
          .slice(0, room)
          .map((attachment) => ({ ...attachment, threadKey }));
        if (accepted.length) {
          pendingAttachmentsRef.current = [...pendingAttachmentsRef.current, ...accepted];
          setPendingAttachments((current) => [...current, ...accepted]);
        }
        const skipped = [
          ...result.skipped,
          ...result.attachments.slice(room).map((attachment) => ({
            name: attachment.name,
            reason: attachmentCountSkipReason(maxCount),
          })),
        ];
        setAttachmentNotice(
          skipped.length
            ? t("Skipped {items}", {
                items: skipped.map((item) => formatAttachmentSkip(item)).join(", "),
              })
            : null,
        );
        if (share.text) composerRef.current?.insert(share.text);
        // A file that became an attachment keeps its share copy until that attachment is sent
        // or removed; the rest are done (a retried one stays with its share).
        const sources = result.sources.slice(0, accepted.length);
        sources.forEach((uri, index) => {
          const id = accepted[index]?.id;
          if (id) retainedShareCopies.set(id, uri);
        });
        // A copy an unsent attachment still owns stays, even when this share left its file out:
        // the share extension reuses a file's name for its copy.
        const owned = new Set(retainedShareCopies.values());
        releaseIncomingShareFiles(share.files.filter((file) => !owned.has(file.uri)));
      } finally {
        importingShare.current = false;
        setShareImporting(false);
        // Only a pass that settings cancelled is tried again; a file the reader
        // rejected is reported once instead of looping until the share expires.
        if (!active && isIncomingShareCurrent(share)) {
          interruptedShare.current = share;
          retryIncomingShare(share);
          setRetryTick((tick) => tick + 1);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [threadKey, readOnly, uploadConfig, retryTick]);
}
