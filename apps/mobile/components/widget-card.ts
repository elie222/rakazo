import type { ViewStyle } from "react-native";
import type { mobileTokens } from "../lib/appearance";

/** Corner radius of a card a bot draws in the thread: a question, an approval, a tool call. */
export const WIDGET_CARD_RADIUS = 22;

/** The raised surface of a thread card: card fill, 1pt border, 22pt corners. */
export function widgetCardSurface(
  tokens: Pick<ReturnType<typeof mobileTokens>, "card" | "border">,
): ViewStyle {
  return {
    backgroundColor: tokens.card,
    borderColor: tokens.border,
    borderWidth: 1,
    borderRadius: WIDGET_CARD_RADIUS,
  };
}
