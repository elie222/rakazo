import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { OrganizationList } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { Alert, StyleSheet, Text, View } from "react-native";
import { resolveMobileAppearance } from "../lib/appearance";
import { native, useThemedStyles } from "../lib/native";
import {
  activeOrganization,
  organizationForAction,
  organizationSwitchActions,
  switchOrganization,
} from "../lib/organizations";
import { NativeSymbol } from "./native-symbol";

/** Switches to the organization row picked from a menu. */
export function useOrganizationMenuAction(list: OrganizationList | undefined) {
  const { t } = useLingui();
  return (action: string) => {
    const target = organizationForAction(list, action);
    if (!target || !list) return;
    void switchOrganization(target, list.organizations).then((switched) => {
      if (!switched) Alert.alert(t`Could not switch spaces`, t`Try again.`);
    });
  };
}

/** The inbox title once there is a second organization: the active one's name, opening a switcher. */
export function OrganizationTitleMenu({ list }: { list: OrganizationList | undefined }) {
  const styles = useThemedStyles(createStyles);
  const onAction = useOrganizationMenuAction(list);
  const actions = organizationSwitchActions(list);
  const active = activeOrganization(list);
  if (actions.length === 0 || !active) return null;
  return (
    <MenuView
      actions={actions}
      colorScheme={resolveMobileAppearance()}
      style={styles.anchor}
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
    anchor: { flexShrink: 1, minWidth: 0 },
    title: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      maxWidth: 220,
      flexShrink: 1,
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
