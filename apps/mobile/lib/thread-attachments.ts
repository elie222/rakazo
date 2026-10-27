import type { MenuAction } from "@expo/ui/community/menu";
import { ATTACHMENT_MAX_COUNT, attachmentMaxBytes } from "@rakazo/contracts";
import { attachmentsForThread } from "@rakazo/core";
import { useRef, useState } from "react";
import { t, useI18n } from "./i18n";
import type { PickedAttachment } from "./pick-attachments";
import { pickDocuments, pickFromLibrary, readDroppedFiles, takePhoto } from "./pick-attachments";
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
  return `${name} (${item.reason})`;
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

  const attachActions: MenuAction[] = [
    { id: "library", title: t("Photo library"), image: "photo.on.rectangle" },
    { id: "camera", title: t("Camera"), image: "camera" },
    { id: "file", title: t("File"), image: "doc" },
  ];

  function attachFrom(source: string) {
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
  };
}
