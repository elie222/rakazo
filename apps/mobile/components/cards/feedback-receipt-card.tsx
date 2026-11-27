import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { Pressable, StyleSheet, Text } from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";
import type { MessageActionProps } from "../thread/message-bubble";

export function FeedbackReceiptCard({
  block,
  actionProps,
}: {
  block: Extract<MessageBlock, { kind: "feedback_receipt" }>;
  actionProps: MessageActionProps;
}) {
  const { t } = useLingui();
  const tokens = mobileTokens();
  return (
    <Pressable {...actionProps} style={[styles.card, { backgroundColor: tokens.card }]}>
      <Text style={{ ...typeScale.cardTitle, color: tokens.foreground }}>
        {block.reportKind === "bug" ? t`Bug report sent` : t`Feedback sent`}
      </Text>
      <Text style={{ ...typeScale.body, color: tokens.foreground }}>{block.description}</Text>
      <Text style={{ ...typeScale.caption, color: tokens.mutedForeground }}>
        {t`Receipt ${block.reportId}`}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12, gap: 6 },
});
