import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { native } from "../../lib/native/native";
import { NativeSymbol } from "../native/native-symbol";

type Step = Extract<MessageBlock, { kind: "steps" }>["steps"][number];

const stepText = (step: Step) => (step.count > 1 ? `${step.label} ×${step.count}` : step.label);

/** What a bot did before it answered, as one quiet line that opens to every step. */
export function StepsLine({ steps }: { steps: readonly Step[] }) {
  const { t } = useLingui();
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
      style={{ alignSelf: "flex-start", maxWidth: "100%", paddingVertical: 2, gap: 4 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <NativeSymbol
          ios="checkmark"
          android="checkmark"
          size={12}
          weight="semibold"
          color={native.secondaryLabel}
        />
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, color: native.secondaryLabel, ...typeScale.caption }}
        >
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
              style={{ color: native.secondaryLabel, ...typeScale.caption, paddingStart: 18 }}
            >
              {stepText(step)}
            </Text>
          ))
        : null}
    </Pressable>
  );
}
