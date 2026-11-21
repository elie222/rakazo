import type { Bot, Group, RoutineEventChange, ThreadMessage } from "@rakazo/contracts";
import type { AskWords, CardStatusWords } from "@rakazo/core";
import { chatTranscriptMarkdown, deadlineSignal, loadPeerHistory, otherAuthor } from "@rakazo/core";
import { downloadArtifactBytes } from "../pages/artifact-open";
import type { RpcClient } from "../query/rpc";

/** Older pages are read until none is left; a chat longer than this fails rather than exporting cut short. */
const MAX_PAGES = 2000;
/** Each page keeps loadPeerHistory's own limit; this bounds a long chat whose pages keep answering slowly. */
const TOTAL_TIMEOUT_MS = 5 * 60_000;

export type ChatToExport = { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group };

/** A chat past MAX_PAGES: the reader gets the generic failure, but it is not reported as an app bug. */
export class ChatTooLongError extends Error {
  override name = "ChatTooLongError";
}

/** `ada-chat.md`: the chat's name as a file name, in any script; `chat.md` when it has no letters. */
export function chatExportFileName(name: string): string {
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}-chat.md` : "chat.md";
}

async function loadAllMessages(rpc: RpcClient, target: ChatToExport): Promise<ThreadMessage[]> {
  const thread = target.kind === "bot" ? { botId: target.chat.id } : { groupId: target.chat.id };
  let pages = 0;
  let pageSignal: AbortSignal | undefined;
  try {
    return await loadPeerHistory({
      // Nothing cancels an export once the menu has closed, so the whole read ends at its own deadline.
      signal: deadlineSignal(TOTAL_TIMEOUT_MS),
      totalTimeoutMs: TOTAL_TIMEOUT_MS,
      loadPage: async (before, signal) => {
        pageSignal = signal;
        pages += 1;
        if (pages > MAX_PAGES) throw new ChatTooLongError("The chat is too long to export");
        return rpc.threads.messages(
          { ...thread, ...(before === undefined ? {} : { before }) },
          { signal },
        );
      },
    });
  } catch (error) {
    // A page or the whole read ran out of time: name it the timeout it is, so it reads as a slow
    // connection rather than a bug (the history's own deadlines abort with a plain Error).
    if (pageSignal?.aborted && error === pageSignal.reason) {
      throw Object.assign(new Error("The chat took too long to export", { cause: error }), {
        name: "TimeoutError",
      });
    }
    throw error;
  }
}

/** Downloads the whole chat as a Markdown file: every page of history, oldest first. */
export async function exportChat(options: {
  rpc: RpcClient;
  target: ChatToExport;
  /** What the file calls the person exporting it when a message names no author, the app itself, a routine's event, an ask card's words and the attachment label. */
  labels: {
    you: string;
    system: string;
    routineEvent: (change: RoutineEventChange, name: string) => string;
    ask: AskWords;
    status: CardStatusWords;
    attachment: string;
  };
  time: (createdAt: string) => string;
  /** A group bot's name as the transcript shows it, including bots that have left the group. */
  memberName: (botId: string | undefined) => string | undefined;
  /** The signed-in person: their own messages read as "You", as the chat shows them. */
  meId?: string;
}): Promise<void> {
  const { rpc, target, labels, time, memberName, meId } = options;
  const messages = await loadAllMessages(rpc, target);
  const markdown = chatTranscriptMarkdown({
    title: target.chat.name,
    messages,
    time,
    routineEvent: labels.routineEvent,
    askWords: labels.ask,
    cardStatus: labels.status,
    attachment: labels.attachment,
    speaker: (message) => {
      if (message.role === "user") return otherAuthor(message.author, meId)?.name ?? labels.you;
      if (message.role === "system") return labels.system;
      if (target.kind === "bot") return target.chat.name;
      return memberName(message.botId) ?? target.chat.name;
    },
  });
  downloadArtifactBytes(
    chatExportFileName(target.chat.name),
    "text/markdown;charset=utf-8",
    new TextEncoder().encode(markdown),
  );
}
