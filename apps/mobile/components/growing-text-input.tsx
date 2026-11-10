import type { ColorValue } from "react-native";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useMobileTokens } from "../lib/native";

const styles = StyleSheet.create({
  multilineField: {
    minHeight: 98,
    fontSize: 14,
    lineHeight: 22,
    padding: 16,
    textAlignVertical: "top",
  },
});

/** A noninteractive text copy gives loaded and edited content its full intrinsic height. */
export function GrowingTextInput({
  label,
  value,
  onChangeText,
  maxLength,
  placeholder,
  backgroundColor,
  inset = 16,
  fontSize = 14,
  editable,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  maxLength?: number;
  placeholder?: string;
  backgroundColor?: ColorValue;
  inset?: number;
  fontSize?: number;
  editable?: boolean;
}) {
  const tokens = useMobileTokens();
  return (
    <View style={{ borderRadius: 11, backgroundColor }}>
      <Text
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.multilineField, { fontSize, padding: inset, opacity: 0 }]}
      >
        {`${value || placeholder || ""}\u200b`}
      </Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        maxLength={maxLength}
        editable={editable}
        placeholder={placeholder}
        placeholderTextColor={tokens.mutedForeground}
        multiline
        scrollEnabled={false}
        style={[
          styles.multilineField,
          {
            color: tokens.foreground,
            fontSize,
            padding: inset,
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
          },
        ]}
      />
    </View>
  );
}
