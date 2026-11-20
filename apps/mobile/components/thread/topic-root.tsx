import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useMobileTokens } from "../../lib/native/native";
import { replyCountLabel } from "../../lib/thread/topics";

/** The top of a topic: the message it replies to, then a divider naming how many replies follow. */
export function TopicRoot({
  root,
  replyCount,
  loadEarlier,
}: {
  root: ReactNode;
  replyCount: number;
  loadEarlier: ReactNode;
}) {
  const tokens = useMobileTokens();
  const line = [styles.line, { backgroundColor: tokens.border }];
  return (
    <View>
      {root}
      {replyCount > 0 ? (
        <View accessible style={styles.divider}>
          <View style={line} />
          <Text style={[styles.label, { color: tokens.mutedForeground }]}>
            {replyCountLabel(replyCount)}
          </Text>
          <View style={line} />
        </View>
      ) : null}
      {loadEarlier}
    </View>
  );
}

const styles = StyleSheet.create({
  divider: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 14 },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
  label: { ...typeScale.footnote, fontWeight: fontWeight.semibold },
});
