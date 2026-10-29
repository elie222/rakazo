import type { ModelHeaderRow } from "@rakazo/contracts";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

const MAX_HEADER_ROWS = 8;

/** Name and secret value pairs; the title appears only once there is a row to label. */
export function HeaderRowsEditor({
  rows,
  onChange,
  disabled,
  savedValuePlaceholder,
}: {
  rows: ModelHeaderRow[];
  onChange: (rows: ModelHeaderRow[]) => void;
  disabled: boolean;
  /** True for a row whose saved value is kept unless a new one is typed. */
  savedValuePlaceholder?: (row: ModelHeaderRow) => boolean;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  return (
    <>
      {rows.length > 0 ? <Text style={styles.sectionTitle}>{t("Headers")}</Text> : null}
      {rows.map((row, index) => (
        <View key={index} style={styles.row}>
          <TextInput
            accessibilityLabel={t("Header name")}
            placeholder={t("Header name")}
            placeholderTextColor={native.tertiaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={!disabled}
            maxLength={256}
            style={styles.input}
            value={row.name}
            onChangeText={(name) =>
              onChange(rows.map((entry, i) => (i === index ? { ...entry, name } : entry)))
            }
          />
          <TextInput
            accessibilityLabel={t("Header value")}
            placeholder={savedValuePlaceholder?.(row) ? "••••••••" : t("Header value")}
            placeholderTextColor={native.tertiaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            textContentType="none"
            secureTextEntry
            editable={!disabled}
            maxLength={1024}
            style={styles.input}
            value={row.value}
            onChangeText={(value) =>
              onChange(rows.map((entry, i) => (i === index ? { ...entry, value } : entry)))
            }
          />
          <NativeActionButton
            accessibilityLabel={t("Remove header")}
            icon={{ ios: "xmark", android: "close" }}
            prominence="plain"
            disabled={disabled}
            onPress={() => onChange(rows.filter((_, i) => i !== index))}
          />
        </View>
      ))}
      <NativeActionButton
        label={t("Add header")}
        prominence="secondary"
        disabled={disabled || rows.length >= MAX_HEADER_ROWS}
        onPress={() => onChange([...rows, { name: "", value: "" }])}
      />
    </>
  );
}

function createStyles() {
  return StyleSheet.create({
    sectionTitle: {
      color: native.secondaryLabel,
      fontSize: 14,
      marginTop: 8,
      marginBottom: 2,
    },
    row: {
      marginTop: 4,
    },
    input: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginTop: 4,
      fontSize: 16,
    },
  });
}
