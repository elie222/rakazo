import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type { OrganizationList } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { useRouter } from "expo-router";
import { Alert, StyleSheet, Text, View } from "react-native";
import { resolveMobileAppearance } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import {
  activeOrganization,
  CREATE_ORGANIZATION_ACTION,
  organizationForAction,
  organizationSwitchActions,
  switchOrganization,
} from "../lib/organizations";
import { NativeSymbol } from "./native-symbol";

/** Handles an organization row (or Create organization) picked from a menu. */
export function useOrganizationMenuAction(list: OrganizationList | undefined) {
  const router = useRouter();
  const { t } = useI18n();
  return (action: string) => {
    if (action === CREATE_ORGANIZATION_ACTION) {
      router.push("/new-organization");
      return;
    }
    const target = organizationForAction(list, action);
    if (!target || !list) return;
    void switchOrganization(target, list.organizations).then((switched) => {
      if (!switched) Alert.alert(t("Could not switch spaces"), t("Try again."));
    });
  };
}

export function organizationTitleActions(
  list: OrganizationList | undefined,
  t: (text: string) => string,
): MenuAction[] {
  const rows = organizationSwitchActions(list);
  if (rows.length === 0) return [];
  return [
    ...rows,
    { id: CREATE_ORGANIZATION_ACTION, title: t("Create organization"), image: "plus" },
  ];
}

/** The inbox title once there is a second organization: the active one's name, opening a switcher. */
export function OrganizationTitleMenu({ list }: { list: OrganizationList | undefined }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const onAction = useOrganizationMenuAction(list);
  const actions = organizationTitleActions(list, t);
  const active = activeOrganization(list);
  if (actions.length === 0 || !active) return null;
  return (
    <MenuView
      actions={actions}
      colorScheme={resolveMobileAppearance()}
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={active.name}
        testID="organization-menu"
        style={styles.title}
      >
        <Text numberOfLines={1} style={styles.name}>
          {active.name}
        </Text>
        <NativeSymbol
          ios="chevron.down"
          android="chevron-down"
          size={12}
          weight="semibold"
          color={native.secondaryLabel}
        />
      </View>
    </MenuView>
  );
}

function createStyles() {
  return StyleSheet.create({
    title: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      maxWidth: 220,
      minHeight: 44,
      paddingHorizontal: 8,
    },
    name: {
      color: native.label,
      ...typeScale.body,
      fontWeight: "600",
      flexShrink: 1,
    },
  });
}
