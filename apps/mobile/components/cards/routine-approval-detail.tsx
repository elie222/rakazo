import { useLingui } from "@lingui/react/macro";
import type { RoutineUpdateApproval } from "@rakazo/contracts";
import { routineApprovalRows } from "@rakazo/i18n/routine-approval";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useMobileTokens } from "../../lib/native/native";
import { NativeSymbol } from "../native/native-symbol";

export function RoutineApprovalDetail({ review }: { review: RoutineUpdateApproval }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [showPrevious, setShowPrevious] = useState(false);
  const secondary = { color: tokens.mutedForeground, ...typeScale.caption };
  return (
    <View style={styles.review}>
      {review.reason ? <Text style={secondary}>{review.reason}</Text> : null}
      {routineApprovalRows(review.changes).map(({ field, label, value, previous }, index) => (
        <View
          key={field}
          style={[
            styles.field,
            index > 0 && {
              borderTopWidth: StyleSheet.hairlineWidth,
              borderColor: tokens.border,
              paddingTop: 12,
            },
          ]}
        >
          <Text style={secondary}>{label}</Text>
          <Text
            style={{
              ...typeScale.secondary,
              color: tokens.foreground,
              fontWeight: field === "prompt" ? fontWeight.regular : fontWeight.medium,
            }}
          >
            {value}
          </Text>
          {field === "prompt" ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showPrevious }}
                onPress={() => setShowPrevious((previous) => !previous)}
                style={styles.disclosure}
              >
                <NativeSymbol
                  ios={showPrevious ? "chevron.down" : "chevron.forward"}
                  android={showPrevious ? "chevron-down" : "chevron-forward"}
                  size={13}
                  color={tokens.foreground}
                />
                <Text style={[secondary, { color: tokens.foreground, flexShrink: 1 }]}>
                  {t`Previous instructions`}
                </Text>
              </Pressable>
              {showPrevious ? <Text style={secondary}>{previous}</Text> : null}
            </>
          ) : (
            <Text style={secondary}>{previous}</Text>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  review: { gap: 12, marginTop: 12 },
  field: { gap: 4 },
  disclosure: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 40 },
});
