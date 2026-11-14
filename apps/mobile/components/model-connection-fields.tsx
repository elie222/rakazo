import { Text, TextInput, View } from "react-native";
import { native, useThemedStyles } from "../lib/native";
import { createModelsStyles } from "./model-connection-styles";
import { SettingsRow } from "./settings-group";

/** A row that shows or hides the section below it. */
export function DisclosureRow({
  label,
  expanded,
  onPress,
}: {
  label: string;
  expanded: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(createModelsStyles);
  return (
    <View style={styles.card}>
      <SettingsRow
        title={label}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        chevron={expanded ? "down" : "right"}
        onPress={onPress}
      />
    </View>
  );
}

/** A whole-number limit, such as maximum output tokens. */
export function LimitField({
  label,
  value,
  onChangeText,
  maxLength,
  busy,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  maxLength: number;
  busy: boolean;
  /** The value that applies while the field is empty. */
  placeholder?: string;
}) {
  const styles = useThemedStyles(createModelsStyles);
  return (
    <View>
      <Text style={styles.sectionTitle}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        editable={!busy}
        keyboardType="number-pad"
        maxLength={maxLength}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={native.tertiaryLabel}
        style={styles.keyInput}
        value={value}
      />
    </View>
  );
}
