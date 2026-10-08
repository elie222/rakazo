import type { ReplyPreview } from "@rakazo/contracts";
import { replyLineText } from "@rakazo/core";
import { Pressable, Text } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { t } from "../lib/i18n";
import { NativeSymbol } from "./native-symbol";

export function ReplyLine({
  targetId,
  quote,
  preview,
  author,
  fallbackText,
  onJump,
}: {
  targetId?: string;
  quote?: string;
  preview?: ReplyPreview | null;
  author: string;
  fallbackText?: string;
  onJump?: (id: string) => void;
}) {
  if (!targetId && quote == null) return null;
  const unavailable = preview === null || !targetId;
  const text = replyLineText(quote, preview?.text, fallbackText);
  const tokens = mobileTokens();
  return (
    <Pressable
      accessibilityRole={unavailable ? "text" : "button"}
      onPress={
        unavailable
          ? undefined
          : () => {
              if (targetId) onJump?.(targetId);
            }
      }
      style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 6 }}
    >
      {unavailable ? null : (
        <NativeSymbol
          ios="arrowshape.turn.up.left"
          android="arrow-undo"
          size={12}
          color={tokens.mutedForeground}
        />
      )}
      <Text
        numberOfLines={1}
        selectable={false}
        style={{ flexShrink: 1, color: tokens.mutedForeground, fontSize: 12.5 }}
      >
        {unavailable ? t("Original message unavailable") : `${author}: ${text}`}
      </Text>
    </Pressable>
  );
}
