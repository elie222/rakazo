import type { ReplyPreview } from "@rakazo/contracts";
import { replyLineText } from "@rakazo/core";
import { Text } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { t } from "../lib/i18n";

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
  return (
    <Text
      numberOfLines={1}
      selectable={false}
      accessibilityRole={unavailable ? "text" : "button"}
      onPress={
        unavailable
          ? undefined
          : () => {
              if (targetId) onJump?.(targetId);
            }
      }
      style={{ color: mobileTokens().mutedForeground, fontSize: 12.5, marginBottom: 6 }}
    >
      {unavailable ? t("Original message unavailable") : `↩ ${author}: ${text}`}
    </Text>
  );
}
