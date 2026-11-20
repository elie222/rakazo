import type { Bot, Group, ThreadMessage } from "@rakazo/contracts";
import { chatTranscriptMarkdown } from "@rakazo/core";
import { downloadArtifactBytes } from "../pages/artifact-open";
import type { RpcClient } from "../query/rpc";

/** Older pages are read until none is left; a chat longer than this fails rather than exporting cut short. */
const MAX_PAGES = 2000;

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
  const pages: ThreadMessage[][] = [];
  let before: number | undefined;
  for (let loaded = 0; loaded < MAX_PAGES; loaded += 1) {
    const page = await rpc.threads.messages({
      ...thread,
      ...(before === undefined ? {} : { before }),
    });
    pages.unshift(page.messages);
    if (page.olderCursor === null) return pages.flat();
    before = page.olderCursor;
  }
  throw new Error("The chat is too long to export");
}

/** Downloads the whole chat as a Markdown file: every page of history, oldest first. */
export async function exportChat(options: {
  rpc: RpcClient;
  target: ChatToExport;
  /** What the file calls the person exporting it when a message names no author, and the app itself. */
  labels: { you: string; system: string };
  time: (createdAt: string) => string;
  /** A group bot's name as the transcript shows it, including bots that have left the group. */
  memberName: (botId: string | undefined) => string | undefined;
}): Promise<void> {
  const { rpc, target, labels, time, memberName } = options;
  const messages = await loadAllMessages(rpc, target);
  const markdown = chatTranscriptMarkdown({
    title: target.chat.name,
    messages,
    time,
    speaker: (message) => {
      if (message.role === "user") return message.author?.name ?? labels.you;
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
