import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { OrganizationList } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { resolveMobileAppearance } from "../../lib/appearance/appearance";
import { native, useThemedStyles } from "../../lib/native/native";
import {
  activeOrganization,
  organizationActions,
  organizationForAction,
  organizationSwitchActions,
  switchOrganization,
} from "../../lib/spaces/organizations";
import { NativeSymbol } from "../native/native-symbol";

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

const NEW_ORGANIZATION = "new-organization";
const ORGANIZATION_SETTINGS = "organization-settings";

/**
 * Wraps the account's organization row: a menu that switches organization, starts a new one,
 * or opens the active one's settings.
 */
export function OrganizationRowMenu({
  list,
  onCreate,
  onSettings,
  children,
}: {
  list: OrganizationList;
  onCreate: () => void;
  onSettings: () => void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const onSwitch = useOrganizationMenuAction(list);
  const active = activeOrganization(list);
  // Native menu hosts size to their contents, so measure outside the host.
  const [width, setWidth] = useState<number>();
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={rowMenuStyles.fullWidth}
    >
      <MenuView
        style={rowMenuStyles.fullWidth}
        actions={[
          {
            id: "organizations",
            title: "",
            displayInline: true,
            subactions: organizationActions(list),
          },
          { id: NEW_ORGANIZATION, title: t`New organization`, image: "plus" },
          { id: ORGANIZATION_SETTINGS, title: t`Organization settings`, image: "gearshape" },
        ]}
        colorScheme={resolveMobileAppearance()}
        onPressAction={({ nativeEvent }) => {
          const action = nativeEvent.event;
          if (action === NEW_ORGANIZATION) onCreate();
          else if (action === ORGANIZATION_SETTINGS) onSettings();
          else if (organizationForAction(list, action)?.id !== active?.id) onSwitch(action);
        }}
      >
        <View style={[rowMenuStyles.fullWidth, { width }]}>{children}</View>
      </MenuView>
    </View>
  );
}

const rowMenuStyles = StyleSheet.create({
  fullWidth: { alignSelf: "stretch" },
});

function createStyles() {
  return StyleSheet.create({
    anchor: { flexShrink: 1, minWidth: 0, maxWidth: "100%" },
    title: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      maxWidth: 220,
      flexShrink: 1,
      minWidth: 0,
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
