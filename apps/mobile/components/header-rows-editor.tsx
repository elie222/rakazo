import type { ModelHeaderRow } from "@rakazo/contracts";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { NativeSymbol } from "./native-symbol";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "./settings-group";

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
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.section}>
      {rows.map((row, index) => (
        <SettingsGroup key={index} label={index === 0 ? t("Headers") : undefined}>
          <SettingsInputRow
            accessibilityLabel={t("Header name")}
            placeholder={t("Header name")}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={!disabled}
            maxLength={256}
            value={row.name}
            onChangeText={(name) =>
              onChange(rows.map((entry, i) => (i === index ? { ...entry, name } : entry)))
            }
          />
          <SettingsInputRow
            accessibilityLabel={t("Header value")}
            placeholder={savedValuePlaceholder?.(row) ? "••••••••" : t("Header value")}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            textContentType="none"
            secureTextEntry
            editable={!disabled}
            maxLength={1024}
            value={row.value}
            onChangeText={(value) =>
              onChange(rows.map((entry, i) => (i === index ? { ...entry, value } : entry)))
            }
          />
          <SettingsRow
            title={t("Remove header")}
            accessibilityLabel={t("Remove header")}
            destructive
            dimmed={disabled}
            disabled={disabled}
            onPress={() => onChange(rows.filter((_, i) => i !== index))}
          />
        </SettingsGroup>
      ))}
      <SettingsGroup>
        <SettingsRow
          title={t("Add header")}
          accessibilityLabel={t("Add header")}
          tinted
          leading={<NativeSymbol ios="plus" android="add" color={tokens.link} />}
          disabled={disabled || rows.length >= MAX_HEADER_ROWS}
          dimmed={disabled || rows.length >= MAX_HEADER_ROWS}
          onPress={() => onChange([...rows, { name: "", value: "" }])}
        />
      </SettingsGroup>
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    section: {
      marginTop: 28,
      gap: 16,
    },
  });
}
