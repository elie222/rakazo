import { isApprovalAskBlock, isSecretAskBlock } from "@rakazo/core";
import type { MobileMessage } from "../api/mobile-types";
import { isCenteredAgentEvent, THREAD_COLUMN_GUTTER } from "./message-presentation";

const COLUMN_PADDING = THREAD_COLUMN_GUTTER * 2;

/** Sizes a message's column: wide asks and centered events fill it, minus the avatar gutter. */
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
  const wideAsk = blocks.some(isSecretAskBlock);
  const full = wideAsk || isCenteredAgentEvent(blocks);
  const fillsBubble = blocks.some(
    (block) =>
      block.kind === "app_connect" ||
      block.kind === "mcp_approval" ||
      block.kind === "tool_question" ||
      block.kind === "app" ||
      block.kind === "page" ||
      (block.kind === "ask" &&
        block.status !== "answered" &&
        Boolean(block.actions?.length) &&
        !isApprovalAskBlock(block) &&
        !block.instructionUpdate &&
        !block.settingsUpdate),
  );
  // A routine row is one centered line, so its menu host spans the column instead of the text.
  const routineRow = blocks.some((block) => block.kind === "routine_event");
  const gutter = activityBotId ? (inGroup ? 28 : 36) : 0;
  return {
    width: full ? "100%" : fillsBubble && !activityBotId ? "90%" : undefined,
    maxWidth: full ? "100%" : activityBotId ? undefined : "90%",
    menuFullWidth: wideAsk || fillsBubble || routineRow,
    menuMaxWidth: wideAsk
      ? columnWidth - COLUMN_PADDING - gutter
      : isCenteredAgentEvent(blocks)
        ? columnWidth - COLUMN_PADDING
        : activityBotId
          ? columnWidth - COLUMN_PADDING - gutter
          : (columnWidth - COLUMN_PADDING) * 0.9,
  } as const;
}
