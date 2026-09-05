import type { MessageBlock } from "@rakazo/contracts";

/** Null is the private application audience. Only trusted inbound routing assigns messaging. */
export function messagingAudience(trigger: string, blocks: MessageBlock[]): string | null {
  if (trigger !== "messaging") return null;
  const channel = blocks.find((block) => block.kind === "channel_message");
  return channel ? `channel:${channel.channelId}` : "dm";
}

export function messagingAudienceChannelId(audience: string | null | undefined): string | null {
  return audience?.startsWith("channel:") ? audience.slice("channel:".length) || null : null;
}
