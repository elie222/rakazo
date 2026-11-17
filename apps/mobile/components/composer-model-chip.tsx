import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import type { ViewStyle } from "react-native";
import { Pressable, Text, View } from "react-native";
import type { ComposerModel } from "../lib/composer-model";
import { useMobileTokens } from "../lib/native";
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
        gap: 8,
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
  show,
  style,
}: {
  model: ComposerModel;
  show: "mark" | "name" | "full";
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
          gap: 4,
          height: 28,
          flexShrink: 1,
        },
        style,
      ]}
    >
      {show === "mark" ? (
        <NativeSymbol
          ios="cpu"
          android="hardware-chip-outline"
          size={16}
          color={tokens.mutedForeground}
        />
      ) : (
        <Text numberOfLines={1} style={{ color: tokens.foreground, fontSize: 15, flexShrink: 1 }}>
          {name}
        </Text>
      )}
      {show === "full" && model.thinking ? (
        <Text numberOfLines={1} style={{ color: tokens.mutedForeground, fontSize: 15 }}>
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
