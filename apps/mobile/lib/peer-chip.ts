/**
 * What tapping a peer chip does. A received chip with folded replies toggles them; any other chip
 * opens the bot-to-bot exchange, which only a bot's own chat has. Otherwise the chip stays still.
 */
export function peerChipPress({
  sent,
  replies,
  threadBotId,
  peerBotId,
}: {
  sent: boolean;
  replies?: "collapsed" | "expanded";
  threadBotId?: string;
  peerBotId: string;
}): "toggle" | "open" | undefined {
  if (!sent && replies) return "toggle";
  if (!threadBotId || !peerBotId || peerBotId === threadBotId) return undefined;
  return "open";
}
