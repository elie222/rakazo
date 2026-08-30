import type { MessageBlock } from "@rakazo/contracts";

type PresentableMessage = {
  runId?: string;
  blocks: readonly MessageBlock[];
};

export function userVisibleMessages<T extends PresentableMessage>(
  messages: readonly T[],
  knownPeerRunIds: Iterable<string> = [],
): T[] {
  const peerRunIds = new Set([
    ...knownPeerRunIds,
    ...messages
      .filter((message) => message.blocks.some((block) => block.kind === "bot_message_received"))
      .flatMap((message) => (message.runId ? [message.runId] : [])),
  ]);

  return messages.filter(
    (message) =>
      !message.blocks.some(
        (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
      ) &&
      (!message.runId || !peerRunIds.has(message.runId)),
  );
}
