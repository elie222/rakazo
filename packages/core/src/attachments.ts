import type { AttachmentMimeType, MessageBlock } from "@rakazo/contracts";
import {
  ATTACHMENT_MAX_BYTES,
  attachmentSizeLabel,
  isAllowedAttachmentMimeType,
  isAttachmentImageMimeType,
} from "@rakazo/contracts";

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

/**
 * Validates base64 without a grouped-repetition regex over the whole string:
 * `/^(?:[A-Za-z0-9+/]{4})*(...)?$/` overflows V8's regex stack on multi-megabyte
 * inputs, which ordinary attachments reach. A flat `[chars]*` quantifier does not;
 * padding is checked separately since it can only be the trailing 0-2 characters.
 */
function isWellFormedBase64(value: string): boolean {
  const paddingMatch = /={1,2}$/.exec(value);
  const paddingLength = paddingMatch ? paddingMatch[0].length : 0;
  const body = paddingLength > 0 ? value.slice(0, value.length - paddingLength) : value;
  if (body.includes("=")) return false;
  return /^[A-Za-z0-9+/]*$/.test(body);
}

export function uploadSizeFromEnv(source: { MAX_UPLOAD_SIZE_MB?: string }): number {
  const value = source.MAX_UPLOAD_SIZE_MB?.trim();
  if (!value) return ATTACHMENT_MAX_BYTES;
  const mb = Number(value);
  // Leave room for base64 expansion and the JSON envelope in the HTTP body guard.
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(mb) ||
    mb <= 0 ||
    mb > Math.floor(Number.MAX_SAFE_INTEGER / (2 * 1024 * 1024))
  ) {
    throw new Error(
      "MAX_UPLOAD_SIZE_MB must be a positive integer number of MiB within the safe byte range",
    );
  }
  return mb * 1024 * 1024;
}

export function decodeAttachmentBase64(
  contentBase64: string,
  maxBytes = ATTACHMENT_MAX_BYTES,
): Uint8Array {
  const normalized = contentBase64.trim();
  if (!normalized) throw new AttachmentValidationError("Attachment content is empty");
  if (normalized.length > Math.ceil(maxBytes / 3) * 4) {
    throw new AttachmentValidationError(
      `Attachment exceeds the ${attachmentSizeLabel(maxBytes)} limit`,
    );
  }
  if (normalized.length % 4 !== 0 || !isWellFormedBase64(normalized)) {
    throw new AttachmentValidationError("Attachment content is not valid base64");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalized, "base64");
  } catch {
    throw new AttachmentValidationError("Attachment content is not valid base64");
  }
  if (bytes.byteLength === 0) throw new AttachmentValidationError("Attachment content is empty");
  if (bytes.byteLength > maxBytes) {
    throw new AttachmentValidationError(
      `Attachment exceeds the ${attachmentSizeLabel(maxBytes)} limit`,
    );
  }
  return new Uint8Array(bytes);
}

export function validateAttachmentMimeType(mimeType: string): void {
  if (!isAllowedAttachmentMimeType(mimeType)) {
    throw new AttachmentValidationError(`Unsupported attachment type: ${mimeType}`);
  }
}

export function attachmentKindForMimeType(mimeType: string): "image" | "file" {
  return isAttachmentImageMimeType(mimeType) ? "image" : "file";
}

export function messageBlockForArtifact(artifact: {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}): Extract<MessageBlock, { kind: "image" | "file" }> {
  if (attachmentKindForMimeType(artifact.mimeType) === "image") {
    return {
      kind: "image",
      artifactId: artifact.id,
      mimeType: artifact.mimeType,
      name: artifact.name,
    };
  }
  return {
    kind: "file",
    artifactId: artifact.id,
    mimeType: artifact.mimeType,
    name: artifact.name,
    size: artifact.size,
  };
}

export function promptTextForAttachments(
  text: string | undefined,
  artifacts: Array<{ name: string; mimeType: string; size: number }>,
): string {
  const caption = text?.trim() ?? "";
  const notes = artifacts
    .filter((artifact) => !isAttachmentImageMimeType(artifact.mimeType))
    .map(
      (artifact) =>
        `User attached file ${JSON.stringify(artifact.name)} (${artifact.mimeType}, ${artifact.size} bytes).`,
    );
  return [caption, ...notes].filter(Boolean).join("\n\n") || "See attached files.";
}

export function blocksToAgentHistoryText(blocks: MessageBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "text") return block.text;
      if (block.kind === "chart") return `[chart: ${block.name}]`;
      if (block.kind === "image") return `[image: ${block.name}]`;
      if (block.kind === "file") {
        return `[file: ${block.name} (${block.mimeType}, ${block.size} bytes)]`;
      }
      // Keep attribution on peer messages: without it a later turn cannot tell
      // which lines came from another bot rather than the user.
      if (block.kind === "bot_message_received") return `[from ${block.fromBotName}] ${block.text}`;
      if (block.kind === "bot_message_sent") return `[to ${block.toBotName}] ${block.text}`;
      if (block.kind === "handoff") {
        return `[handoff ${block.fromBotId} -> ${block.toBotId}] ${block.text}`;
      }
      // Without the answer a later turn sees the question as still open and asks it again.
      if (block.kind === "ask") {
        if (block.status !== "answered" || !block.answer) return block.text;
        const choice = block.actions?.find((action) => action.id === block.answer);
        return `${block.text}\nAnswer: ${choice?.label ?? block.answer}`;
      }
      // The bot needs the outcome of its own call: a missed call is its cue to follow up.
      if (block.kind === "call_request") {
        const outcome = {
          ringing: "still ringing",
          answered: "the user answered",
          declined: "the user declined it",
          missed: "the user did not answer",
        }[block.status];
        return `[you called the user about: ${block.reason}; ${outcome}]${block.status === "answered" ? `\n${block.opening}` : ""}`;
      }
      if ("text" in block && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const EXTENSION_MIME_TYPES: Record<string, AttachmentMimeType> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".zip": "application/zip",
};

const MIME_TYPE_EXTENSIONS: Record<AttachmentMimeType, string> = {
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/html": ".html",
  "application/json": ".json",
  "application/zip": ".zip",
};

export function inferAttachmentMimeType(
  name: string,
  reportedType?: string,
): AttachmentMimeType | null {
  if (
    reportedType === "application/x-zip-compressed" ||
    reportedType === "application/x-zip" ||
    reportedType === "multipart/x-zip"
  ) {
    return "application/zip";
  }
  const audioAliases: Record<string, AttachmentMimeType> = {
    "audio/mp3": "audio/mpeg",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/vnd.wave": "audio/wav",
    "audio/x-m4a": "audio/mp4",
  };
  if (reportedType && Object.hasOwn(audioAliases, reportedType)) return audioAliases[reportedType]!;
  // audio/aac may describe an M4A's codec, not its container. Infer from .m4a;
  // do not advertise standalone AAC streams as MP4 containers.
  const dot = name.lastIndexOf(".");
  const extensionType = dot < 0 ? undefined : EXTENSION_MIME_TYPES[name.slice(dot).toLowerCase()];
  // Some browsers and native document pickers report Markdown as text/plain.
  if (extensionType === "text/markdown" && (!reportedType || reportedType === "text/plain")) {
    return extensionType;
  }
  if (reportedType && isAllowedAttachmentMimeType(reportedType)) return reportedType;
  return extensionType ?? null;
}

export function attachmentExtensionForMimeType(mimeType: string): string {
  return isAllowedAttachmentMimeType(mimeType) ? MIME_TYPE_EXTENSIONS[mimeType] : "";
}

export function attachmentsForThread<T extends { threadKey: string }>(
  attachments: readonly T[],
  threadKey: string | undefined,
): T[] {
  if (!threadKey) return [];
  return attachments.filter((attachment) => attachment.threadKey === threadKey);
}

export function attachmentsForBot<T extends { botId: string }>(
  attachments: readonly T[],
  botId: string | undefined,
): T[] {
  if (!botId) return [];
  return attachments.filter((attachment) => attachment.botId === botId);
}

export function userTurnMessageForRun<
  T extends { id?: string; role: string; runId?: string | null; blocks: MessageBlock[] },
>(trigger: string, runId: string, messages: T[], sourceMessageId?: string | null): T | undefined {
  if (trigger !== "user" && trigger !== "messaging" && trigger !== "reaction") return undefined;
  return messages.find(
    (message) =>
      message.role === "user" &&
      (sourceMessageId ? message.id === sourceMessageId : message.runId === runId),
  );
}
