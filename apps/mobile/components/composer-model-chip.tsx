import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import type { ViewStyle } from "react-native";
import { Pressable, Text, View } from "react-native";
import type { ComposerModel } from "../lib/composer-model";
import { useMobileTokens } from "../lib/native";
import { ModelMarkIcon } from "./model-mark";
import { NativeSymbol } from "./native-symbol";

/** The model, dictation and send: inline beside the text, or a row under it once stacked. */
export function TrailingControls({ stacked, children }: { stacked: boolean; children: ReactNode }) {
  if (!stacked) return <>{children}</>;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 6,
        paddingBottom: 8,
      }}
    >
      {children}
    </View>
  );
}

/** The chat's model in the message box; tapping it opens the model sheet. */
export function ModelChip({
  model,
  full,
  style,
}: {
  model: ComposerModel;
  full: boolean;
  style?: ViewStyle;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const name = model.label;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t`Model: ${ph({ model: name })}`}
      accessibilityValue={model.thinking ? { text: model.thinking } : undefined}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      onPress={model.onPress}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 3,
          height: 28,
          flexShrink: 1,
        },
        style,
      ]}
    >
      <ModelMarkIcon mark={model.mark} size={15} color={tokens.foreground} />
      {full ? (
        <Text numberOfLines={1} style={{ color: tokens.foreground, fontSize: 14, flexShrink: 1 }}>
          {name}
        </Text>
      ) : null}
      {full && model.thinking ? (
        <Text numberOfLines={1} style={{ color: tokens.mutedForeground, fontSize: 14 }}>
          {model.thinking}
        </Text>
      ) : null}
      <NativeSymbol
        ios="chevron.down"
        android="chevron-down"
        size={11}
        color={tokens.mutedForeground}
      />
    </Pressable>
  );
}
