import { useLingui } from "@lingui/react/macro";
import { APP_LOCALE_LABELS, reportUiLocale } from "@rakazo/core";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import { Checkmark } from "../../components/ui/row-accessories";
import { currentApiBase, selectedSpaceId } from "../../lib/api/api";
import { loadSessionToken } from "../../lib/api/session";
import { mobileTokens } from "../../lib/appearance/appearance";
import { getActiveUiLocale, setUiLocale, useUiLocale } from "../../lib/i18n/i18n";
import type { UiLocale } from "../../lib/i18n/ui-locale";
import { UI_LOCALES } from "../../lib/i18n/ui-locale";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { resumeLiveNotifications } from "../../lib/notifications/live-notifications";
import { useSave } from "../../lib/query/query";
import { ACCOUNT_SETTINGS } from "../../lib/query/settings-target";

export default function Language() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const locale = useUiLocale();
  const styles = useThemedStyles(createStyles);
  const change = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (code: UiLocale, send) => {
      await setUiLocale(code);
      // Emails follow the app's language too; a failure leaves the next app start to save it.
      void reportUiLocale(getActiveUiLocale, (locale) =>
        send("preferences/update", { locale }),
      ).catch(() => undefined);
      // Native notification copy follows the locale, but a failure there must
      // not read as a failed language change: the choice is already applied.
      await resumeLiveNotifications(
        currentApiBase(),
        await loadSessionToken(),
        selectedSpaceId() ?? "",
      ).catch(() => undefined);
    },
  });
  const saving = change.pending;
  const error = change.error ? t`Could not change language` : null;

  function applyLocale(code: UiLocale) {
    if (code !== locale) change.run(code);
  }

  return (
    <ScrollView
      style={[styles.screen, sideInsets]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <SettingsGroup accessibilityLabel={t`Language`}>
        {UI_LOCALES.map((code) => {
          const selected = code === locale;
          const label = APP_LOCALE_LABELS[code];
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
