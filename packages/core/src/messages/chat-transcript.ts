import type { MessageBlock, RoutineEventChange } from "@rakazo/contracts";
import { resolveAskChoice } from "../asks/answerable-ask.js";
import { isSecretAskBlock } from "../asks/ask-kind.js";
import { separateAskAnswers } from "../asks/ask-replies.js";
import { receiptItems } from "../runs/action-approval.js";
import { helperCardState } from "../runs/run-state.js";
import { isRetiredImportSetup, isToolActivityBlock } from "../runs/tool-activity.js";
import { projectMessageReactions } from "./message-reactions.js";
import { channelMessageLine } from "./message-text.js";
import { foldPeerReplies } from "./message-visibility.js";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

type TranscriptMessage = {
  id: string;
  runId?: string;
  role: string;
  replyToMessageId?: string | null;
  blocks: MessageBlock[];
  createdAt: string;
};

/** The words an ask's card shows, in the reader's language. */
export type AskWords = {
  answer: string;
  expired: string;
  more: (count: string) => string;
  total: string;
  onTheButton: string;
  to: string;
  subject: string;
  updateInstructions: string;
  instructionsUpdated: string;
  settingsUpdated: string;
  /** The note under a payment's amounts: they were read from the page and not checked. */
  readFromPage: string;
  buttonReadFromPage: (button: string) => string;
};

/** The state words the chat's cards show, in the reader's language. */
export type CardStatusWords = {
  saved: string;
  sent: string;
  dismissed: string;
  running: string;
  completed: string;
  failed: string;
  stopped: string;
  archived: string;
  deleted: string;
};

/** Markdown that only character escapes can make, the same in every CommonMark reader. */
const INLINE_SYNTAX = /[\\`*_[\]<>|~&#]/g;
/** What starts a list or rule only at the start of a line. */
const LINE_START_SYNTAX = /^(\s*)([+=-]|\d+[.)])/;
/** Leading spaces and tabs of a line with text, which Markdown would read as code or drop. */
const LEADING_WHITESPACE = /^[ \t]+(?=\S)/;
const NO_BREAK_SPACE = "\u00a0";

/**
 * Text the chat shows as typed, escaped so a Markdown reader shows it the same: no formatting,
 * headings or lists of its own, and each line break kept.
 */
function literal(text: string): string {
  const lines = text.split("\n").map((line) =>
    line
      .replace(LEADING_WHITESPACE, (indent) =>
        indent.replace(/\t/g, NO_BREAK_SPACE.repeat(4)).replace(/ /g, NO_BREAK_SPACE),
      )
      .replace(INLINE_SYNTAX, "\\$&")
      .replace(
        LINE_START_SYNTAX,
        (_, space: string, mark: string) => `${space}${mark.replace(/[\\+=.)-]/g, "\\$&")}`,
      ),
  );
  // A backslash at the end of a line is a hard break; a blank line stays a paragraph break.
  return lines
    .map((line, i) => (line.trim() && lines[i + 1]?.trim() ? `${line}\\` : line))
    .join("\n");
}

const ASCII_SPACE = " \t\r\n";

/** Trims ASCII spaces and line breaks only: a no-break space at an edge is typed text. */
function trimAsciiEdges(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && ASCII_SPACE.includes(text.charAt(start))) start += 1;
  while (end > start && ASCII_SPACE.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** A name or title on one line, so it can never start a heading or speaker of its own. */
function oneLine(text: string): string {
  return literal(text.replace(/\s+/g, " ").trim());
}

/** A value the user typed for a secret or a login is never written to the file. */
function holdsSecret(block: AskBlock): boolean {
  return (
    block.input === "secret" ||
    isSecretAskBlock(block) ||
    Boolean(block.loginFields || block.oneTimeCode || block.credential || block.replaces)
  );
}

/**
 * Raw Markdown from a bot, closed when it leaves a code fence open. The chat renders each message on
 * its own, so an unclosed fence must not run into the next message in the file.
 */
function closeOpenFence(markdown: string): string {
  let open: string | undefined;
  // The closing fence sits in the opener's column (indentation, list or quote markers), so an
  // indented code block or list item stays the one it was.
  let closer = "";
  const lines = markdown.split("\n").map((line) => {
    // One optional list or quote marker before the fence; no nested repeats, so a long run of spaces cannot backtrack.
    const fence = /^([ \t]*(?:(?:[-+*]|\d+[.)]|>)[ \t]+)?)(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) return open ? line : escapeHtml(line);
    const lead = fence[1] ?? "";
    const mark = fence[2] ?? "";
    const rest = fence[3] ?? "";
    if (!open) {
      // A backtick fence's info string cannot hold a backtick; otherwise the line is text.
      if (!(mark[0] === "`" && rest.includes("`"))) {
        open = mark;
        closer = `${lead.replace(/\S/g, " ")}${mark}`;
      }
    } else if (mark[0] === open[0] && mark.length >= open.length && rest.trim() === "") {
      open = undefined;
    }
    return line;
  });
  const text = lines.join("\n");
  return open ? `${text}\n${closer}` : text;
}

/** An autolink's `<scheme:...>` after its `<`, which the chat shows as a link and is left as it is. */
const AUTOLINK = /[a-z][a-z0-9+.-]*:[^\s<>]*>/iy;

/** The index just after the run of backticks that starts at `from`. */
function backtickRunEnd(line: string, from: number): number {
  let end = from;
  while (line.charAt(end) === "`") end += 1;
  return end;
}

/** The index just after the code span a backtick run opens, closed by a run of the same length. */
function codeSpanEnd(line: string, start: number): number | undefined {
  const width = backtickRunEnd(line, start) - start;
  let at = line.indexOf("`", backtickRunEnd(line, start));
  while (at !== -1) {
    const end = backtickRunEnd(line, at);
    if (end - at === width) return end;
    at = line.indexOf("`", end);
  }
  return undefined;
}

/** The chat shows a bot's raw HTML as nothing; escaped here, an unclosed tag cannot hide what follows. */
function escapeHtml(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const char = line.charAt(i);
    if (char === "\\") {
      // A backslash escapes the character after it, so an escaped backtick opens no code span.
      out += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === "`") {
      // A backtick run that closes no code span is text, so only its own run is copied.
      const end = codeSpanEnd(line, i) ?? backtickRunEnd(line, i);
      out += line.slice(i, end);
      i = end;
      continue;
    }
    if (char === "<") {
      // An odd run of backslashes already escapes the "<"; an even one needs a backslash of its own.
      let slashes = 0;
      while (line.charAt(i - 1 - slashes) === "\\") slashes += 1;
      AUTOLINK.lastIndex = i + 1;
      const needsEscape = slashes % 2 === 0 && !AUTOLINK.test(line);
      out += needsEscape ? "\\<" : "<";
    } else {
      out += char;
    }
    i += 1;
  }
  return out;
}

/** Text the card shows as preformatted, in a fence longer than any backtick run inside it. */
function fenced(text: string): string {
  let longest = 2;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/** A receipt's rows in the order its card shows them. */
function receiptMarkdown(receipt: NonNullable<AskBlock["receipt"]>, words: AskWords): string {
  const rows = receiptItems(receipt.items, [words.total, words.onTheButton]).map(
    (item) => `- ${oneLine(item.name)}: ${oneLine(item.amount)}`,
  );
  if (receipt.more) {
    rows.push(`- ${words.more(`${receipt.more.count}${receipt.more.atLeast ? "+" : ""}`)}`);
  }
  if (receipt.total) rows.push(`- ${words.total}: ${oneLine(receipt.total)}`);
  if (receipt.amount) {
    const label = receipt.amountSource === "button" ? words.onTheButton : words.total;
    rows.push(`- ${label}: ${oneLine(receipt.amount)}`);
  }
  // The card's note under the rows: the page's amounts are not checked.
  const note = receipt.button
    ? words.buttonReadFromPage(oneLine(receipt.button))
    : words.readFromPage;
  return [rows.join("\n"), note].filter(Boolean).join("\n\n");
}

/** An outgoing draft's card shows its recipient, subject and body, not the question. */
function draftMarkdown(values: NonNullable<AskBlock["outgoingDraft"]>["values"], words: AskWords) {
  const parts = [`${words.to}: ${oneLine(values.to)}`];
  if (values.kind === "email" && values.subject.trim()) {
    parts.push(`${words.subject}: ${oneLine(values.subject)}`);
  }
  parts.push(literal(values.body));
  return parts.join("\n\n");
}

/**
 * An ask as its card shows it: the question, its detail or receipt, its options with the chosen one
 * marked, and a typed answer unless that answer is its own message. A secret answer is never written.
 */
function askMarkdown(
  block: AskBlock,
  words: AskWords,
  status: CardStatusWords,
  answeredInOwnMessage: boolean,
): string {
  if (block.outgoingDraft) return draftMarkdown(block.outgoingDraft.values, words);
  // A settled change shows only that it happened, with an undo.
  if (block.instructionUpdate?.undoVersionId) return words.instructionsUpdated;
  if (block.settingsUpdate) return words.settingsUpdated;
  // The card translates its own "Update instructions?" question; the stored text is English.
  const question = block.instructionUpdate ? words.updateInstructions : closeOpenFence(block.text);
  const actions = block.actions ?? [];
  // An expired approval stores its refusal as the answer, but no option was chosen.
  const chosen =
    block.status === "answered" && block.answer && !block.expired
      ? resolveAskChoice(block.answer, actions)
      : undefined;
  // The secret card shows a detail only for a one-time code; the prompt card shows it always.
  const shownDetail =
    block.detail && (!isSecretAskBlock(block) || block.oneTimeCode) ? block.detail : "";
  const detail = block.receipt
    ? receiptMarkdown(block.receipt, words)
    : shownDetail
      ? block.detailFormat === "text"
        ? literal(shownDetail)
        : fenced(shownDetail)
      : "";
  const options = actions
    .map((action) => `- ${oneLine(action.label)}${action.id === chosen?.id ? " \u2713" : ""}`)
    .join("\n");
  const answer =
    !actions.length &&
    block.status === "answered" &&
    block.answer &&
    block.answer !== "approved" &&
    !block.expired &&
    !answeredInOwnMessage &&
    !holdsSecret(block)
      ? `${words.answer}: ${literal(block.answer)}`
      : "";
  // A protected answer is never written, but the card's outcome for it is.
  const outcome =
    block.status === "answered" && isSecretAskBlock(block) ? secretOutcome(block, status) : "";
  return [question, detail, options, answer, outcome, block.expired ? words.expired : ""]
    .filter(Boolean)
    .join("\n\n");
}

/** A protected answer's outcome, worded as its card words it. */
function secretOutcome(block: AskBlock, status: CardStatusWords): string {
  if (block.dismissed) return status.dismissed;
  return block.remembered === false || block.oneTimeCode ? status.sent : status.saved;
}

/**
 * A block as the chat shows it, in words; empty for what the chat leaves out. What the chat renders
 * as Markdown (a bot's reply, progress, a question, a computer's note) stays Markdown; everything it
 * shows as typed (your own messages, labels, names) is escaped to read the same.
 */
function blockMarkdown(
  block: MessageBlock,
  role: string,
  words: {
    routineEvent: (change: RoutineEventChange, name: string) => string;
    ask: AskWords;
    status: CardStatusWords;
    attachment: string;
  },
  answeredInOwnMessage: boolean,
): string {
  if (isToolActivityBlock(block) || isRetiredImportSetup(block)) return "";
  switch (block.kind) {
    case "text":
      return role === "user" ? literal(block.text) : closeOpenFence(block.text);
    case "progress":
    case "computer":
      return closeOpenFence(block.text);
    case "ask":
      return askMarkdown(block, words.ask, words.status, answeredInOwnMessage);
    case "meta":
    case "handoff":
      return literal(block.text);
    case "channel_message":
      return literal(channelMessageLine(block));
    case "image":
    case "file":
      return `${words.attachment}: ${oneLine(block.name)}`;
    case "choice": {
      if (block.answerId === "_dismissed") return "";
      const options = block.options.map(
        (option) =>
          `- ${oneLine(option.letter)}. ${oneLine(option.label)}${block.answerId === option.id ? " ✓" : ""}`,
      );
      // A list may follow the question on the next line, as the chat's card shows it.
      const head = [literal(block.question), ...(block.subtitle ? [literal(block.subtitle)] : [])];
      return [head.join("\n\n"), options.join("\n")].filter(Boolean).join("\n");
    }
    case "card":
      return block.lines.map((line) => `- ${oneLine(line.k)} → ${oneLine(line.v)}`).join("\n");
    case "page":
    case "voice_call":
    case "cloud_agent":
      return oneLine(block.title);
    case "call_request":
      // The card shows the opening, which is spoken text, once the call is answered; the reason
      // while it rings or after it was missed.
      return block.status === "answered" ? literal(block.opening) : literal(block.reason);
    case "subagent": {
      // The card shows the helper's name with its state, then its task, then its result (or its
      // progress while it works) as Markdown; a stopped helper shows no body.
      const { stopped, failed, body } = helperCardState(block);
      const state =
        block.status === "running"
          ? words.status.running
          : stopped
            ? words.status.stopped
            : failed
              ? words.status.failed
              : words.status.completed;
      const task = trimAsciiEdges(block.task);
      return [
        `**${oneLine(block.name)}** · ${state}`,
        task ? literal(task) : "",
        body ? closeOpenFence(body) : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "routine_event":
      return oneLine(words.routineEvent(block.change, block.name));
    case "child_bot":
      // The chat shows an archived or deleted bot's status beside its name.
      return oneLine(
        block.status === "created"
          ? block.name
          : `${block.name} · ${block.status === "archived" ? words.status.archived : words.status.deleted}`,
      );
    case "chart":
    case "app_connect":
    case "mcp_approval":
    case "skill_draft":
      return oneLine(block.name);
    case "app":
      return oneLine(`${block.server}: ${block.tool}`);
    case "tool_question":
      return [literal(block.question.source), literal(block.question.message)]
        .filter(Boolean)
        .join("\n\n");
    case "import_setup":
      return block.items
        .map((item) => `- ${oneLine("name" in item ? item.name : item.title)}`)
        .join("\n");
    // Left out: a delivery is the bot's prompt, tool steps are activity, and a peer receipt is a
    // chip in the chat whose bot-to-bot replies stay folded away.
    case "connect":
    case "delivery":
    case "steps":
    case "bot_message_sent":
    case "bot_message_received":
      return "";
  }
}

/** A readable copy of a chat as Markdown: who said what and when, in the order it was said. */
export function chatTranscriptMarkdown<T extends TranscriptMessage>(options: {
  title: string;
  messages: readonly T[];
  /** Who wrote the message, as the chat shows them. */
  speaker: (message: T) => string;
  /** When the message was sent, as the person reads dates. */
  time: (createdAt: string) => string;
  /** A routine's creation, change, switch or deletion, in the reader's words. */
  routineEvent: (change: RoutineEventChange, name: string) => string;
  /** An ask card's labels and totals, in the reader's words. */
  askWords: AskWords;
  /** A card's state words (saved, running, archived and so on), in the reader's words. */
  cardStatus: CardStatusWords;
  /** The label before an attached file's name, in the reader's words. */
  attachment: string;
}): string {
  // Folded as the chat folds them: work a bot did for another bot stays under its receipt, and an
  // emoji-only reply shows under the message it reacts to.
  const { visibleMessages, reactions } = projectMessageReactions(
    foldPeerReplies(options.messages, { includePeerReceipts: true }).messages,
  );
  const separateAnswers = separateAskAnswers(visibleMessages);
  const words = {
    routineEvent: options.routineEvent,
    ask: options.askWords,
    status: options.cardStatus,
    attachment: options.attachment,
  };
  const entries = visibleMessages.flatMap((message) => {
    const body = message.blocks
      .map((block) =>
        // Only ASCII edges go: a no-break space at the start is typed indentation, not a gap.
        trimAsciiEdges(
          blockMarkdown(
            block,
            message.role,
            words,
            separateAnswers.get(message.id)?.has(block) ?? false,
          ),
        ),
      )
      .filter(Boolean)
      .join("\n\n");
    if (!body) return [];
    const counts = reactions.get(message.id);
    const reactionLine = counts
      ? `\n\n${[...counts].map(([emoji, count]) => (count > 1 ? `${emoji} ${count}` : emoji)).join(" ")}`
      : "";
    return [
      `**${oneLine(options.speaker(message))}** · ${options.time(message.createdAt)}\n\n${body}${reactionLine}`,
    ];
  });
  return `${[`# ${oneLine(options.title)}`, ...entries].join("\n\n---\n\n")}\n`;
}
