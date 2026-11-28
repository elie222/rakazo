import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { native, useThemedStyles } from "../../lib/native/native";
import { NativeSymbol } from "../native/native-symbol";

type Step = Extract<MessageBlock, { kind: "steps" }>["steps"][number];

function createStyles() {
  return StyleSheet.create({
    line: { alignSelf: "flex-start", maxWidth: "100%", paddingVertical: 2, gap: 4 },
    summaryRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    summary: { flexShrink: 1, color: native.secondaryLabel, ...typeScale.caption },
    step: { color: native.secondaryLabel, ...typeScale.caption, paddingStart: 18 },
  });
}

const stepText = (step: Step) => (step.count > 1 ? `${step.label} ×${step.count}` : step.label);

/** What a bot did before it answered, as one quiet line that opens to every step. */
export function StepsLine({ steps }: { steps: readonly Step[] }) {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const summary = steps.map(stepText).join(", ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={summary}
      accessibilityHint={open ? t`Hide steps` : t`Show steps`}
      accessibilityState={{ expanded: open }}
      hitSlop={6}
      onPress={() => setOpen((value) => !value)}
      style={styles.line}
    >
      <View style={styles.summaryRow}>
        <NativeSymbol
          ios="checkmark"
          android="checkmark"
          size={12}
          weight="semibold"
          color={native.secondaryLabel}
        />
        <Text numberOfLines={1} style={styles.summary}>
          {summary}
        </Text>
        <NativeSymbol
          ios={open ? "chevron.up" : "chevron.down"}
          android={open ? "chevron-up" : "chevron-down"}
          size={10}
          weight="semibold"
          color={native.secondaryLabel}
        />
      </View>
      {open
        ? steps.map((step, index) => (
            <Text
              // Steps repeat labels, so their order is their identity.
              key={index}
              style={styles.step}
            >
              {stepText(step)}
            </Text>
          ))
        : null}
    </Pressable>
  );
}
