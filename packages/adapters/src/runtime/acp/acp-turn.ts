import { createHash } from "node:crypto";
import type { AgentInputImage, AgentRunRequest } from "@rakazo/adapter-kit";
import type { AgentSession } from "./acp-sessions.js";
import {
  conversationClose,
  conversationOpen,
  historyLine,
  imageList,
  imageSource,
  OWN_SPEAKER,
  PERSON_SPEAKER,
} from "./acp-turn.prompt.js";

type Block = Record<string, unknown>;

/** How much of the chat a new session is given, newest first, in characters. */
const SEED_CHARS = 32_000;

function speakerOf(item: AgentRunRequest["history"][number]): string {
  const own = item.role === "assistant" && !item.speaker;
  return item.speaker ?? (own ? OWN_SPEAKER : item.role === "system" ? "Note" : PERSON_SPEAKER);
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * This turn's message: the chat the session has not seen, then the new message. A new session
 * gets the newest part of the chat that fits; a continued one only what others wrote since.
 */
export function turnText(
  request: AgentRunRequest,
  session: AgentSession,
  fresh: boolean,
  includeOwn: boolean,
  withImages: boolean,
): { blocks: Block[]; leftOut: number } {
  const lines: Array<{ line: string; images: readonly AgentInputImage[]; id?: string }> = [];
  const late: Array<{ line: string; images: readonly AgentInputImage[] }> = [];
  for (const item of request.history) {
    const content = item.content.trim();
    // The new message itself goes last, as the prompt.
    if (!content || (item.id && item.id === request.sourceMessageId)) continue;
    const own = item.role === "assistant" && !item.speaker;
    if (item.id) {
      if (session.seen.has(item.id)) {
        // An image that could not be read when the session first saw its message comes now.
        if (item.images?.length && !session.imaged.has(item.id)) {
          session.imaged.add(item.id);
          late.push({ line: historyLine(speakerOf(item), content), images: item.images });
        }
        continue;
      }
      session.seen.add(item.id);
      // The session wrote this reply itself, unless a turn running beside it did.
      if (own && !fresh && (!includeOwn || session.replies.has(contentHash(content)))) continue;
    } else {
      const hash = contentHash(content);
      if (session.context.has(hash)) continue;
      session.context.add(hash);
    }
    lines.push({
      line: historyLine(speakerOf(item), content),
      images: item.images ?? [],
      id: item.id,
    });
  }
  if (request.sourceMessageId) session.seen.add(request.sourceMessageId);
  // As with ids: only summaries and recall still in this turn's history can come up again.
  const inContext = new Set(
    request.history.filter((item) => !item.id).map((item) => contentHash(item.content.trim())),
  );
  for (const hash of session.context) if (!inContext.has(hash)) session.context.delete(hash);
  // Only ids still in the chat's history window can come up again, so the rest are let go.
  const inWindow = new Set(request.history.map((item) => item.id).filter(Boolean));
  for (const id of session.seen) {
    if (!inWindow.has(id) && id !== request.sourceMessageId) session.seen.delete(id);
  }
  for (const id of session.imaged) if (!inWindow.has(id)) session.imaged.delete(id);
  let kept = lines;
  if (fresh) {
    // The newest messages that fit; the newest one is kept, shortened, even when it alone does not.
    let size = 0;
    const start = lines.findLastIndex(({ line }) => {
      size += line.length;
      return size > SEED_CHARS;
    });
    kept =
      start >= 0 && start === lines.length - 1
        ? [{ ...lines[start]!, line: `…${lines[start]!.line.slice(-SEED_CHARS)}` }]
        : lines.slice(start + 1);
  }
  // Only images actually sent count as sent: an entry cut from a new session's history sends its
  // image later, once it is the session's.
  for (const { id, images } of kept) if (id && images.length) session.imaged.add(id);
  if (request.sourceMessageId && request.currentTurnImages?.length) {
    session.imaged.add(request.sourceMessageId);
  }
  const message = request.promptSpeaker
    ? historyLine(request.promptSpeaker, request.prompt)
    : request.prompt;
  // Each image right after the message it came with, so the model can tell them apart.
  const blocks: Block[] = [];
  let leftOut = 0;
  const text = (value: string) => {
    const last = blocks.at(-1);
    if (last?.type === "text") last.text = `${String(last.text)}\n\n${value}`;
    else blocks.push({ type: "text", text: value });
  };
  const sources: string[] = [];
  const attach = (images: readonly AgentInputImage[], line?: string) => {
    if (!withImages) {
      leftOut += images.length;
      return;
    }
    for (const image of images) {
      sources.push(imageSource(line));
      blocks.push({
        type: "image",
        mimeType: image.mimeType,
        data: Buffer.from(image.data).toString("base64"),
      });
    }
  };
  if (kept.length) {
    text(conversationOpen(fresh));
    for (const { line, images } of kept) {
      text(line);
      attach(images, line);
    }
    text(conversationClose(fresh));
  }
  for (const { line, images } of late) attach(images, line);
  text(message);
  attach(request.currentTurnImages ?? []);
  // Images from more than one message are named, since a CLI may show them apart from the text.
  if (new Set(sources).size > 1) text(imageList(sources));
  return { blocks, leftOut };
}
