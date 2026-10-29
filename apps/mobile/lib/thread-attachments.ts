import type { MenuAction } from "@expo/ui/community/menu";
import { ATTACHMENT_MAX_COUNT, attachmentMaxBytes } from "@rakazo/contracts";
import { attachmentsForThread } from "@rakazo/core";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import type { ThreadComposerHandle } from "../components/thread-composer";
import { t, useI18n } from "./i18n";
import { isIncomingShareCurrent, retryIncomingShare, takeIncomingShare } from "./incoming-share";
import type { PickedAttachment } from "./pick-attachments";
import {
  pickDocuments,
  pickFromLibrary,
  readDroppedFiles,
  readSharedFiles,
  takePhoto,
} from "./pick-attachments";
import { attachmentCountSkipReason } from "./pick-attachments-filter";
import { useFileDrop } from "./use-file-drop";

export type PendingAttachment = PickedAttachment & { threadKey: string };

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
}: {
  botId?: string;
  groupId?: string;
  readOnly: boolean;
  uploadConfig?: { maxUploadSizeBytes?: number };
}) {
  const { t } = useI18n();
  const threadKey = groupId ?? botId;
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const activePendingAttachments = attachmentsForThread(pendingAttachments, threadKey);
  // Read by a second drop that starts before the first one commits.
  const pendingAttachmentsRef = useRef(pendingAttachments);
  pendingAttachmentsRef.current = pendingAttachments;
  const importingShare = useRef(false);
  const [shareImporting, setShareImporting] = useState(false);

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
    ) => Promise<{
      attachments: PickedAttachment[];
      skipped: Array<{ name: string; reason: string }>;
    }>,
  ) {
    const targetKey = groupId ?? botId;
    if (!targetKey) return;
    const result = await picker(activePendingAttachments.length, attachmentMaxBytes(uploadConfig));
    if ((groupId ?? botId) !== targetKey) return;
    // Two drops can overlap, so the room left is settled against the draft as it
    // is now, not as it was when this read began.
    const room = Math.max(
      0,
      ATTACHMENT_MAX_COUNT - attachmentsForThread(pendingAttachmentsRef.current, targetKey).length,
    );
    const accepted = result.attachments.slice(0, room);
    if (accepted.length) {
      setPendingAttachments((current) => [
        ...current,
        ...accepted.map((attachment) => ({
          ...attachment,
          threadKey: targetKey,
        })),
      ]);
    }
    const skipped = [
      ...result.skipped,
      ...result.attachments.slice(room).map((attachment) => ({
        name: attachment.name,
        reason: attachmentCountSkipReason(),
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
      void addAttachments((count, maxBytes) => readDroppedFiles(files, count, maxBytes, skipped));
    },
    {
      enabled: !readOnly && Boolean(groupId ?? botId),
      maxBytes: attachmentMaxBytes(uploadConfig),
      maxFiles: ATTACHMENT_MAX_COUNT,
    },
  );

  return {
    pendingAttachments,
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
  uploadConfig?: { maxUploadSizeBytes?: number };
}) {
  const { importingShare, setShareImporting, setPendingAttachments, setAttachmentNotice } =
    attachments;
  // The share a settings refresh interrupted. It is retried on its own, so a
  // share that arrived in the meantime is left for the picker, not taken here.
  const interruptedShare = useRef<{ generation: number } | null>(null);
  const [retryTick, setRetryTick] = useState(0);
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
        );
        if (!active || !isIncomingShareCurrent(share)) {
          retryIncomingShare(share);
          return;
        }
        if (result.failedFiles.length)
          retryIncomingShare({ ...share, text: "", files: result.failedFiles });
        setPendingAttachments((current) => [
          ...current,
          ...result.attachments.map((attachment) => ({ ...attachment, threadKey })),
        ]);
        setAttachmentNotice(
          result.skipped.length
            ? t("Skipped {items}", {
                items: result.skipped.map((item) => formatAttachmentSkip(item)).join(", "),
              })
            : null,
        );
        if (share.text) composerRef.current?.insert(share.text);
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
