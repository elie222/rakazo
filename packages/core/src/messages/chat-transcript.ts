import type { MessageBlock, RoutineEventChange } from "@rakazo/contracts";
import { commandVariableName, outgoingDraftPresentation } from "@rakazo/contracts";
import { resolveAskChoice } from "../asks/answerable-ask.js";
import { isSecretAskBlock } from "../asks/ask-kind.js";
import { separateAskAnswers } from "../asks/ask-replies.js";
import { callDurationText } from "../calls/voice-chat-groups.js";
import { cloudAgentHttpsUrl } from "../integrations/cloud-agent.js";
import {
  ALLOW_IN_SPACE_LABELS,
  isApprovalAskBlock,
  receiptItems,
} from "../runs/action-approval.js";
import { helperCardState } from "../runs/run-state.js";
import { isRetiredImportSetup, isToolActivityBlock } from "../runs/tool-activity.js";
import {
  TAKEOVER_COMPUTER_DONE_STATE,
  TAKEOVER_COMPUTER_PENDING_STATE,
  TAKEOVER_COMPUTER_SKIPPED_STATE,
} from "../threads/thread-message-updates.js";
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
  approved: string;
  discarded: string;
  /** The label before a command-line secret's variable name. */
  commandVariable: string;
  /** Where a one-time code came from, by the site's host. */
  codeFrom: (host: string) => string;
  /** An answered card's state line once its buttons are gone, as the card words it. */
  answered: string;
  created: string;
  cancelled: string;
  allowedInSpace: string;
  allowedOnce: string;
  alwaysAllowed: string;
  denied: string;
  answeredWith: (answer: string) => string;
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
  setupComplete: string;
  /** The label on a call's card, before its length. */
  phoneCall: string;
  /** The label on the card of an answered call the bot placed, before its length. */
  incomingCall: string;
  /** A call the bot placed while it rings, after it was missed or declined, and the declined note. */
  callingYou: string;
  missedCall: string;
  youDeclined: string;
  /** A connection or server the person connected. */
  connected: string;
  /** A tool's question the person declined. */
  declined: string;
  /** A computer request's states: waiting on the person, skipped or done. */
  needsYou: string;
  skipped: string;
  done: string;
  /** A cloud agent's badge, lower case as the card shows it. */
  cloudAgent: Record<Extract<MessageBlock, { kind: "cloud_agent" }>["status"], string>;
};

/** The labels the chat's cards show around their content, in the reader's language. */
export type CardLabels = {
  computer: string;
  pullRequest: string;
  connectMcpServer: (name: string) => string;
  draftSkill: string;
  /** A skill draft's field labels, in the order its card shows them. */
  skillName: string;
  whenToUse: string;
  inputs: string;
  steps: string;
  howToCheck: string;
  whatToReturn: string;
  approvalBoundaries: string;
  failureHandling: string;
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
  // The open fence and the container it sits in: a list item's content column, a quote, or an
  // indented block (four or more columns before it). A line outside that container ends the fence
  // with it, as Markdown reads it, so a bare fence after it opens a new block rather than closing.
  let open: { mark: string; quote: boolean; column: number; closer: string } | undefined;
  // Indented code (four spaces or a tab, after a blank line or more indented code) is shown as
  // typed, so its "<" stays as it is, like a fence's. The start of the message counts as blank.
  // Inside a list item or quote the same indent continues the item's text, which stays escaped, so
  // indented code counts only once a plain paragraph after a blank line has ended any list.
  let afterBlank = true;
  let inIndentedCode = false;
  let inContainer = false;
  // The content columns of the list items seen since the list began, so a fence on an item's
  // continuation line belongs to its item rather than the margin.
  let itemColumns: number[] = [];
  const lines = markdown.split("\n").map((line) => {
    const blank = line.trim() === "";
    const wasAfterBlank = afterBlank;
    afterBlank = blank;
    if (open) {
      // The line with the container's own prefix taken off, or undefined when it leaves the container.
      const inside = open.quote
        ? /^ {0,3}>/.test(line)
          ? line.replace(/^ {0,3}> ?/, "")
          : undefined
        : blank || indentWidth(line) >= open.column
          ? dropColumns(line, open.column)
          : undefined;
      if (inside !== undefined) {
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(inside)?.[1];
        if (closing && closing[0] === open.mark[0] && closing.length >= open.mark.length) {
          open = undefined;
        }
        return line;
      }
      open = undefined;
    }
    // One optional list or quote marker before the fence; no nested repeats, so a long run of spaces cannot backtrack.
    const fence = /^([ \t]*(?:(?:[-+*]|\d+[.)]|>)[ \t]+)?)(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) {
      if (blank) return line;
      const indented = /^(?: {4}|\t)/.test(line);
      // A heading or thematic break at the margin ends a list, blank line or not; checked before
      // the item marker so "- - -" reads as the break it is.
      const breaksList =
        /^(?:#{1,6}(?:[ \t]|$)|(?:\*[ \t]*){3,}$|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$)/.test(line);
      if (!indented) {
        if (breaksList) {
          inContainer = false;
          itemColumns = [];
        } else if (/^ {0,3}(?:[-+*]|\d+[.)])(?:[ \t]|$)|^ {0,3}>/.test(line)) {
          inContainer = true;
          // A quote at the margin ends any list before it.
          if (line.startsWith(">")) itemColumns = [];
        }
        // Only a line at the margin ends a list: an item's own later paragraphs sit a few spaces in.
        else if (wasAfterBlank && !/^[ \t]/.test(line)) {
          inContainer = false;
          itemColumns = [];
        }
      }
      // A nested item sits under its parent's content, so it may be indented four or more.
      const item = !breaksList && (!indented || inContainer) ? listItemColumn(line) : undefined;
      if (item !== undefined) itemColumns.push(item);
      inIndentedCode = indented && !inContainer && (wasAfterBlank || inIndentedCode);
      return inIndentedCode ? line : escapeHtml(line);
    }
    inIndentedCode = false;
    const lead = fence[1] ?? "";
    if (/\S/.test(lead)) inContainer = true;
    const mark = fence[2] ?? "";
    const rest = fence[3] ?? "";
    const quote = lead.includes(">");
    const width = indentWidth(lead.replace(/\S/g, " "));
    if (/\S/.test(lead) && !quote) itemColumns.push(width);
    // A backtick fence's info string cannot hold a backtick; otherwise the line is text.
    if (!(mark[0] === "`" && rest.includes("`"))) {
      // Without a marker of its own, a fence in a list belongs to the deepest item it reaches.
      const itemColumn = inContainer
        ? itemColumns.reduce(
            (deepest, column) => (column <= width ? Math.max(deepest, column) : deepest),
            -1,
          )
        : -1;
      // A plain fence that reaches no item sits outside the list, which it ends.
      if (!/\S/.test(lead) && itemColumn < 0) {
        inContainer = false;
        itemColumns = [];
      }
      open = {
        mark,
        quote,
        // A fence indented less than four columns at the margin has no container to leave.
        column:
          quote || /\S/.test(lead) ? width : itemColumn >= 0 ? itemColumn : width >= 4 ? width : 0,
        // The closer sits in the opener's column, keeping a quote's marker so it stays in the quote.
        closer: `${quote ? lead.replace(/[^\s>]/g, " ") : " ".repeat(width)}${mark}`,
      };
    }
    return line;
  });
  const text = lines.join("\n");
  return open ? `${text}\n${open.closer}` : text;
}

/**
 * Where a list item's content starts when the line opens one: past its marker and the spaces after
 * it, or one column past the marker when five or more follow (the rest is then indented code).
 */
function listItemColumn(line: string): number | undefined {
  const item = /^( *(?:[-+*]|\d{1,9}[.)]))( *)/.exec(line);
  if (!item) return undefined;
  const marker = item[1]?.length ?? 0;
  const spaces = item[2]?.length ?? 0;
  const rest = line.slice(item[0].length);
  if (spaces === 0 && rest !== "") return undefined;
  return rest === "" || spaces > 4 ? marker + 1 : marker + spaces;
}

/** How many columns a line's leading whitespace takes, a tab reaching the next multiple of four. */
function indentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** The line with its first `columns` columns of leading whitespace taken off. */
function dropColumns(line: string, columns: number): string {
  let width = 0;
  let i = 0;
  while (i < line.length && width < columns) {
    const char = line[i];
    if (char === " ") width += 1;
    else if (char === "\t") width += 4 - (width % 4);
    else break;
    i += 1;
  }
  return line.slice(i);
}

/**
 * Whether an autolink `<scheme:...>` starts at the `<` at `at`. The chat shows it as a link, so it is
 * left as it is. A plain scan, so a long line of letters cannot cost more than its length.
 */
function isAutolinkAt(line: string, at: number): boolean {
  let i = at + 1;
  if (!/[a-z]/i.test(line.charAt(i))) return false;
  i += 1;
  while (/[a-z0-9+.-]/i.test(line.charAt(i))) i += 1;
  if (line.charAt(i) !== ":") return false;
  i += 1;
  while (i < line.length && !/[\s<>]/.test(line.charAt(i))) i += 1;
  return line.charAt(i) === ">";
}

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
      const needsEscape = slashes % 2 === 0 && !isAutolinkAt(line, i);
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
  if (block.outgoingDraft) {
    // The card names an answered draft's outcome; a pending one names none.
    const { status: draftStatus } = outgoingDraftPresentation(
      block,
      block.outgoingDraft.values,
      block.outgoingDraft.values,
      false,
    );
    const outcome =
      draftStatus === "expired"
        ? words.expired
        : draftStatus === "discarded"
          ? words.discarded
          : draftStatus === "approved"
            ? words.approved
            : "";
    return [draftMarkdown(block.outgoingDraft.values, words), outcome].filter(Boolean).join("\n\n");
  }
  // A settled change shows only that it happened, with an undo.
  if (block.instructionUpdate?.undoVersionId) return words.instructionsUpdated;
  if (block.settingsUpdate) return words.settingsUpdated;
  // The card translates its own "Update instructions?" question; the stored text is English.
  const question = block.instructionUpdate ? words.updateInstructions : closeOpenFence(block.text);
  const actions = block.actions ?? [];
  const approval = isApprovalAskBlock(block);
  const answered = block.status === "answered";
  // As the card: only a plain question keeps its options once answered, with the chosen one marked;
  // an approval or instructions update swaps its buttons for the outcome.
  const optionQuestion = !approval && !block.instructionUpdate && actions.length > 0;
  const typed =
    answered &&
    !optionQuestion &&
    !approval &&
    !block.instructionUpdate &&
    Boolean(block.answer) &&
    block.answer !== "approved";
  // An expired approval stores its refusal as the answer, but no option was chosen.
  const chosen =
    block.status === "answered" && block.answer && !block.expired
      ? resolveAskChoice(block.answer, actions)
      : undefined;
  // The secret card shows a detail only for a one-time code; the prompt card shows it always.
  const shownDetail =
    block.detail && (!isSecretAskBlock(block) || block.oneTimeCode) ? block.detail : "";
  // A protected request names where its answer goes, as its card does.
  const destination = isSecretAskBlock(block) ? secretDestination(block, words) : "";
  // The shared-browser and replaced-login notices are left out: they only come with a saved login,
  // whose card shows them to the run's owner alone while it waits, which the export cannot tell.
  const detail = block.receipt
    ? receiptMarkdown(block.receipt, words)
    : shownDetail
      ? block.detailFormat === "text"
        ? literal(shownDetail)
        : fenced(shownDetail)
      : "";
  const options = (optionQuestion || !answered ? actions : [])
    .map((action) => `- ${oneLine(action.label)}${action.id === chosen?.id ? " \u2713" : ""}`)
    .join("\n");
  const answer =
    typed && block.answer && !block.expired && !answeredInOwnMessage && !holdsSecret(block)
      ? `${words.answer}: ${literal(block.answer)}`
      : "";
  // A protected answer is never written, but the card's outcome for it is.
  const outcome = !answered
    ? ""
    : isSecretAskBlock(block)
      ? secretOutcome(block, status)
      : optionQuestion || typed || block.expired
        ? ""
        : answeredState(block, approval, words, status);
  return [
    question,
    destination,
    detail,
    options,
    answer,
    outcome,
    block.expired ? words.expired : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** An answered card's state line once its buttons are gone, as the card words it. */
function answeredState(
  block: AskBlock,
  approval: boolean,
  words: AskWords,
  status: CardStatusWords,
): string {
  const answer = block.answer;
  if (block.instructionUpdate) return answer === "deny" ? status.dismissed : words.allowedOnce;
  if (!answer) return words.answered;
  if (!approval) return status.sent;
  const outcome = block.actions?.find((action) => action.id === answer)?.outcome;
  if (outcome === "created") return words.created;
  if (outcome === "cancelled") return words.cancelled;
  if (answer === "allow") {
    return block.actions?.some((action) => ALLOW_IN_SPACE_LABELS.has(action.label))
      ? words.allowedInSpace
      : words.allowedOnce;
  }
  if (answer === "always") return words.alwaysAllowed;
  if (answer === "deny") return words.denied;
  return oneLine(words.answeredWith(answer));
}

const FORM_AUTH_TYPES = new Set(["card", "contact"]);

/** The line a protected request's card shows under its question: the variable, the code's site or the login's site. */
function secretDestination(block: AskBlock, words: AskWords): string {
  const credential = block.credential;
  if (credential?.auth.type === "command") {
    return oneLine(`${words.commandVariable} $${commandVariableName(credential.name)}`);
  }
  if (block.oneTimeCode) return oneLine(words.codeFrom(new URL(block.oneTimeCode.origin).host));
  if (credential?.auth.type === "login") return oneLine(siteHostOf(credential.origin));
  // Card, contact and login forms show no origin; other credentials show it as it is.
  if (credential && !FORM_AUTH_TYPES.has(credential.auth.type)) return oneLine(credential.origin);
  return "";
}

/** A login's site as its card shows it: the host, without a leading www. */
function siteHostOf(origin: string): string {
  return URL.canParse(origin) ? new URL(origin).host.replace(/^www\./, "") : origin;
}

/**
 * A skill draft as its card shows it: the heading and goal, then each field under its label, and
 * Saved once it is saved. The fields are plain text boxes, so they are written as typed.
 */
function skillDraftMarkdown(
  block: Extract<MessageBlock, { kind: "skill_draft" }>,
  labels: CardLabels,
  status: CardStatusWords,
): string {
  const { playbook } = block;
  const fields: [string, string][] = [
    [labels.whenToUse, playbook.whenToUse],
    [labels.inputs, playbook.inputs.join("\n")],
    [labels.steps, playbook.steps.join("\n")],
    [labels.howToCheck, playbook.howToCheck],
    [labels.whatToReturn, playbook.whatToReturn],
    [labels.approvalBoundaries, playbook.approvalBoundaries],
    [labels.failureHandling, playbook.failureHandling],
  ];
  return [
    `**${oneLine(labels.draftSkill)}**`,
    block.goal.trim() ? literal(block.goal) : "",
    block.name.trim() ? `${oneLine(labels.skillName)}: ${oneLine(block.name)}` : "",
    ...fields.map(([label, value]) =>
      // A backslash ends the label's line, so the value starts on the next one.
      value.trim() ? `${oneLine(label)}:\\\n${literal(trimAsciiEdges(value))}` : "",
    ),
    block.status === "saved" ? status.saved : "",
  ]
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
    labels: CardLabels;
    memberName: (botId: string) => string;
    attachment: string;
    isSetupComplete: (block: Extract<MessageBlock, { kind: "import_setup" }>) => boolean;
    placedCalls: ReadonlyMap<string, { durationSeconds?: number }>;
    /** When the export is written, in epoch milliseconds: a call still ringing past its end reads as missed. */
    now: number;
  },
  answeredInOwnMessage: boolean,
): string {
  if (isToolActivityBlock(block) || isRetiredImportSetup(block)) return "";
  switch (block.kind) {
    case "text":
      return role === "user" ? literal(block.text) : closeOpenFence(block.text);
    case "progress":
      return closeOpenFence(block.text);
    case "computer": {
      // The card names the computer and the request's state, then what was asked.
      const state =
        block.state === TAKEOVER_COMPUTER_PENDING_STATE
          ? words.status.needsYou
          : block.state === TAKEOVER_COMPUTER_SKIPPED_STATE
            ? words.status.skipped
            : block.state === TAKEOVER_COMPUTER_DONE_STATE
              ? words.status.done
              : block.state;
      return [oneLine(`${words.labels.computer} · ${state}`), closeOpenFence(block.text)]
        .filter(Boolean)
        .join("\n\n");
    }
    case "ask":
      return askMarkdown(block, words.ask, words.status, answeredInOwnMessage);
    case "meta":
      return literal(block.text);
    case "handoff":
      // The chat row names both bots before the text, as it does here.
      return [
        oneLine(`↪ ${words.memberName(block.toBotId)} ← ${words.memberName(block.fromBotId)}`),
        literal(block.text),
      ]
        .filter(Boolean)
        .join("\n\n");
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
      return oneLine(block.title);
    case "cloud_agent":
      // The card's title with its state badge, then a pull request or, failing that, the branch.
      return [
        oneLine(`${block.title} · ${words.status.cloudAgent[block.status]}`),
        cloudAgentHttpsUrl(block.prUrl)
          ? oneLine(words.labels.pullRequest)
          : block.branch
            ? oneLine(block.branch)
            : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    case "voice_call": {
      // A call the bot placed ends with this marker under its request's id: its card reads Incoming
      // call and takes the length from the request when the marker has none (the bot hung up).
      // Otherwise, with no recorded length, the card counts it from the message times, which the
      // export leaves out.
      const placed = block.callId ? words.placedCalls.get(block.callId) : undefined;
      const label = placed ? words.status.incomingCall : words.status.phoneCall;
      const seconds = block.durationSeconds ?? placed?.durationSeconds;
      return [
        seconds === undefined ? label : `${label} · ${callDurationText(seconds)}`,
        oneLine(block.title),
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "call_request": {
      // The card shows the opening, which is spoken text, once the call is answered (its marker
      // writes the state); otherwise its state, then the reason. A ring past its end reads as missed.
      if (block.status === "answered") return literal(block.opening);
      const ringing = block.status === "ringing" && Date.parse(block.expiresAt) > words.now;
      const state = ringing
        ? words.status.callingYou
        : block.status === "declined"
          ? `${words.status.missedCall} · ${words.status.youDeclined}`
          : words.status.missedCall;
      return [oneLine(state), literal(block.reason)].filter(Boolean).join("\n\n");
    }
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
      return oneLine(block.name);
    case "app_connect":
      // The card shows the app, what it is for and, once connected, that it is; a pending one
      // shows only its Connect button.
      return [
        oneLine(block.name),
        oneLine(block.description),
        block.status === "connected" ? words.status.connected : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    case "mcp_approval":
      // The server and where it runs, then its decision; a pending one shows only buttons.
      return [
        oneLine(words.labels.connectMcpServer(block.name)),
        oneLine(block.endpoint ?? `stdio (${block.transport})`),
        block.status === "connected"
          ? words.status.connected
          : block.status === "dismissed"
            ? words.status.dismissed
            : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    case "skill_draft":
      return skillDraftMarkdown(block, words.labels, words.status);
    case "app":
      return oneLine(`${block.server}: ${block.tool}`);
    case "tool_question":
      // An answered question shows its outcome under the question, as its card does.
      return [
        literal(block.question.source),
        literal(block.question.message),
        block.status === "accepted"
          ? words.status.sent
          : block.status === "declined"
            ? words.status.declined
            : block.status === "expired"
              ? words.ask.expired
              : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    case "import_setup":
      // Once every item is done the card shows only that setup is complete, so the export does too.
      if (words.isSetupComplete(block)) return oneLine(words.status.setupComplete);
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
  /** The labels around a card's content (a skill draft's fields), in the reader's words. */
  cardLabels: CardLabels;
  /** A group bot's name as the chat shows it, for a handoff between bots. */
  memberName: (botId: string) => string;
  /** The label before an attached file's name, in the reader's words. */
  attachment: string;
  /** Whether a checklist's card shows it complete, which the caller checks against the bot's setup. */
  isSetupComplete: (block: Extract<MessageBlock, { kind: "import_setup" }>) => boolean;
  /** When the export is written, in epoch milliseconds; the current time unless a test fixes it. */
  now?: number;
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
    labels: options.cardLabels,
    memberName: options.memberName,
    attachment: options.attachment,
    isSetupComplete: options.isSetupComplete,
    now: options.now ?? Date.now(),
    placedCalls: new Map(
      options.messages.flatMap((message) =>
        message.blocks.flatMap((block) =>
          block.kind === "call_request" ? [[block.callId, block] as const] : [],
        ),
      ),
    ),
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
