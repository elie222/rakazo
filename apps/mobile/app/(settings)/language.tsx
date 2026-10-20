import { useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { Checkmark } from "../../components/row-accessories";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { setUiLocale, useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import type { UiLocale } from "../../lib/ui-locale";
import { UI_LOCALE_LABELS, UI_LOCALES } from "../../lib/ui-locale";

export default function Language() {
  const { t, locale } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyLocale(code: UiLocale) {
    if (code === locale || saving) return;
    setSaving(true);
    setError(null);
    void setUiLocale(code)
      .catch(() => {
        setError(t("Could not change language"));
      })
      .finally(() => setSaving(false));
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <SettingsGroup accessibilityLabel={t("Language")}>
        {UI_LOCALES.map((code) => {
          const selected = code === locale;
          const label = UI_LOCALE_LABELS[code];
          return (
            <SettingsRow
              key={code}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected, disabled: saving }}
              dimmed={saving}
              disabled={saving}
              onPress={() => applyLocale(code)}
              title={label}
              trailing={selected ? <Checkmark /> : null}
            />
          );
        })}
      </SettingsGroup>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },
    error: {
      color: tokens.destructive,
      fontSize: 15,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
  });
}
