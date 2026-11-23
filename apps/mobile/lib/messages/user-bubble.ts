import type { ColorTokens } from "@rakazo/ui-tokens";

export type UserBubble = { background: string; foreground: string };

/** Your bubbles take the bot's color in its own chat. */
export function withUserBubble(
  tokens: ColorTokens,
  userBubble: UserBubble | undefined,
): ColorTokens {
  return userBubble
    ? { ...tokens, chatUser: userBubble.background, chatUserForeground: userBubble.foreground }
    : tokens;
}
