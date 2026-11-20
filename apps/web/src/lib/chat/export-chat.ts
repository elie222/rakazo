import type { Bot, Group, RoutineEventChange, ThreadMessage } from "@rakazo/contracts";
import { chatTranscriptMarkdown, deadlineSignal, loadPeerHistory, otherAuthor } from "@rakazo/core";
import { downloadArtifactBytes } from "../pages/artifact-open";
import type { RpcClient } from "../query/rpc";

/** Older pages are read until none is left; a chat longer than this fails rather than exporting cut short. */
const MAX_PAGES = 2000;
/** Each page keeps loadPeerHistory's own limit; this bounds a long chat whose pages keep answering slowly. */
const TOTAL_TIMEOUT_MS = 5 * 60_000;

export type ChatToExport = { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group };

/** `ada-chat.md`: the chat's name as a file name, in any script; `chat.md` when it has no letters. */
export function chatExportFileName(name: string): string {
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}-chat.md` : "chat.md";
}

async function loadAllMessages(rpc: RpcClient, target: ChatToExport): Promise<ThreadMessage[]> {
  const thread = target.kind === "bot" ? { botId: target.chat.id } : { groupId: target.chat.id };
  let pages = 0;
  return loadPeerHistory({
    // Nothing cancels an export once the menu has closed, so the whole read ends at its own deadline.
    signal: deadlineSignal(TOTAL_TIMEOUT_MS),
    totalTimeoutMs: TOTAL_TIMEOUT_MS,
    loadPage: async (before, signal) => {
      pages += 1;
      if (pages > MAX_PAGES) throw new Error("The chat is too long to export");
      return rpc.threads.messages(
        { ...thread, ...(before === undefined ? {} : { before }) },
        { signal },
      );
    },
  });
}

/** Downloads the whole chat as a Markdown file: every page of history, oldest first. */
export async function exportChat(options: {
  rpc: RpcClient;
  target: ChatToExport;
  /** What the file calls the person exporting it when a message names no author, the app itself, and a routine's event. */
  labels: {
    you: string;
    system: string;
    routineEvent: (change: RoutineEventChange, name: string) => string;
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
