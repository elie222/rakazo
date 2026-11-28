import type { MobileMessage } from "../api/mobile-types";
import { isCenteredAgentEvent, THREAD_COLUMN_GUTTER } from "./message-presentation";

const COLUMN_PADDING = THREAD_COLUMN_GUTTER * 2;

/** Blocks drawn as a card rather than a text bubble. */
const CARD_KINDS: ReadonlySet<MobileMessage["blocks"][number]["kind"]> = new Set([
  "app",
  "app_connect",
  "ask",
  "choice",
  "computer",
  "feedback_receipt",
  "import_setup",
  "mcp_approval",
  "page",
  "tool_question",
]);

/**
 * Sizes a message's column. Every card shares one width, so a run of cards lines up; centered
 * events fill the column, minus the avatar gutter. A card is given a set width rather than
 * hugging its text, because the iOS menu host measures its child without a width and would
 * otherwise reserve less height than wrapped text draws, letting the next message overlap it.
 */
export function messageRowLayout(
  blocks: MobileMessage["blocks"],
  {
    activityBotId,
    inGroup,
    columnWidth,
  }: {
    activityBotId?: string;
    inGroup: boolean;
    columnWidth: number;
  },
) {
  const centered = isCenteredAgentEvent(blocks);
  const card = !centered && blocks.some((block) => CARD_KINDS.has(block.kind));
  // A routine row is one centered line, so its menu host spans the column instead of the text.
  const routineRow = blocks.some((block) => block.kind === "routine_event");
  const gutter = activityBotId ? (inGroup ? 28 : 36) : 0;
  return {
    width: centered ? "100%" : card && !activityBotId ? "90%" : undefined,
    maxWidth: centered ? "100%" : activityBotId ? undefined : "90%",
    menuFullWidth: card || routineRow,
    menuMaxWidth: centered
      ? columnWidth - COLUMN_PADDING
      : activityBotId
        ? columnWidth - COLUMN_PADDING - gutter
        : (columnWidth - COLUMN_PADDING) * 0.9,
  } as const;
}
