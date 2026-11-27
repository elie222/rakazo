import { useLingui } from "@lingui/react/macro";
import type { AppIcon } from "@rakazo/contracts";
import { APP_ICONS } from "@rakazo/contracts";
import { appIconLabel } from "@rakazo/i18n/app-icon";
import { Image, ScrollView, StyleSheet, Text } from "react-native";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import { Checkmark } from "../../components/ui/row-accessories";
import { APP_ICON_IMAGES, appIconRead, setAppIcon } from "../../lib/appearance/app-icon";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { queryClient, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";

export default function AppIconSettings() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const { data } = useScreenQuery(appIconRead);
  const change = useSave({
    save: async (icon: AppIcon) => {
      await setAppIcon(icon);
      queryClient.setQueryData(appIconRead.queryKey, { supported: true, icon });
    },
    stale: [appIconRead.queryKey],
  });
  const shown = change.pending ? change.input : data?.icon;

  return (
    <ScrollView
      style={[styles.screen, sideInsets]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <SettingsGroup accessibilityLabel={t`App icon`}>
        {APP_ICONS.map((icon) => {
          const selected = icon === shown;
          const label = appIconLabel(icon);
          return (
            <SettingsRow
              key={icon}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected, disabled: change.pending }}
              disabled={change.pending || !data}
              onPress={() => {
                if (icon !== data?.icon) change.run(icon);
              }}
              leading={<Image source={APP_ICON_IMAGES[icon]} style={styles.icon} />}
              title={label}
              trailing={selected ? <Checkmark /> : null}
            />
          );
        })}
      </SettingsGroup>
      {change.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t`Couldn't change the app icon`}
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
    icon: { width: 40, height: 40, borderRadius: 9, borderCurve: "continuous" },
    error: {
      color: tokens.destructive,
      fontSize: 15,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
  });
}
