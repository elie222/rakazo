import type { MessageBlock } from "@rakazo/contracts";

export function isCenteredAgentEvent(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.kind === "handoff" ||
      block.kind === "bot_message_sent" ||
      block.kind === "bot_message_received",
  );
}

type ToolBlock = Extract<MessageBlock, { kind: "progress" | "steps" }>;

export function toolBlocksForMessage(blocks: readonly MessageBlock[]): ToolBlock[] {
  const visible: ToolBlock[] = [];
  for (const block of blocks) {
    if (!isToolBlock(block)) continue;
    if (block.kind === "steps") {
      const steps = block.steps.filter((step) => !isMessageBotName(step.label));
      if (steps.length > 0) visible.push({ ...block, steps });
      continue;
    }
    const pendingToolNames = (block.pendingToolNames ?? []).filter(
      (name) => !isMessageBotName(name),
    );
    if (pendingToolNames.length > 0 || !isMessageBotName(block.text)) {
      visible.push({ ...block, pendingToolNames });
    }
  }
  return visible;
}

export function toolOwnerId(
  message: { botId?: string; blocks: readonly MessageBlock[] },
  inGroup: boolean,
): string | undefined {
  return inGroup && toolBlocksForMessage(message.blocks).length > 0 ? message.botId : undefined;
}

export function hasVisibleMessagePresentation(blocks: readonly MessageBlock[]): boolean {
  return blocks.some((block) => !isToolBlock(block) || toolBlocksForMessage([block]).length > 0);
}

export function isToolBlock(block: MessageBlock): block is ToolBlock {
  return (
    block.kind === "steps" ||
    (block.kind === "progress" &&
      ((block.pendingToolNames?.length ?? 0) > 0 || /^Using\s+/i.test(block.text)))
  );
}

function isMessageBotName(value: string): boolean {
  return /(?:^|\b)message[ _-]?bot(?:\b|$)/i.test(value);
}
