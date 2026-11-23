import { useLingui } from "@lingui/react/macro";
import { connectedAppMarks } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useThemedStyles } from "../../lib/native/native";
import { queryClient, rpcQuery } from "../../lib/query/query";
import { ConnectorIcon } from "../integrations/connector-icon";
import { GlassSurface } from "../native/glass-surface";
import { NativeSymbol } from "../native/native-symbol";
import { createInboxStyles } from "./inbox-styles";

const INTEGRATIONS_PATH = "/integrations";
const MARK_SIZE = 26;
// Matches the header's gap above its buttons, plus a little room for the home indicator.
const HOME_INDICATOR_ROOM = 8;

/** The sidebar's foot: the account, and the apps its bots can use with a way to connect more. */
export function InboxFooter({
  initial,
  columnInsets,
}: {
  initial: string;
  columnInsets: { left: number; right: number };
}) {
  const inboxStyles = useThemedStyles(createInboxStyles);
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const marks = useConnectedAppMarks();
  return (
    <View
      style={[
        styles.footer,
        {
          paddingLeft: 16 + columnInsets.left,
          paddingRight: 16 + columnInsets.right,
          paddingBottom: 8 + Math.min(insets.bottom, HOME_INDICATOR_ROOM),
        },
      ]}
    >
      <GlassSurface
        shape="circle"
        style={inboxStyles.headerCircle}
        fallbackStyle={inboxStyles.headerFill}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t`Account`}
          onPress={() => router.push("/account")}
          hitSlop={4}
          style={({ pressed }) => [
            inboxStyles.headerButton,
            pressed && inboxStyles.headerButtonActive,
          ]}
        >
          <Text style={inboxStyles.profileInitials}>{initial}</Text>
        </Pressable>
      </GlassSurface>
      <GlassSurface shape="capsule" style={styles.apps} fallbackStyle={inboxStyles.headerFill}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t`Connect apps`}
          onPress={() => router.push(INTEGRATIONS_PATH)}
          hitSlop={4}
          style={({ pressed }) => [styles.appsButton, pressed && inboxStyles.headerButtonActive]}
        >
          {marks.length > 0 ? (
            <>
              {marks.map((mark, index) => (
                <View key={mark.name} style={[styles.mark, index > 0 && styles.overlap]}>
                  <ConnectorIcon name={mark.name} logo={mark.logo} size={MARK_SIZE} />
                </View>
              ))}
              <View style={[styles.mark, styles.plus, styles.overlap]}>
                <NativeSymbol ios="plus" android="add" size={14} />
              </View>
            </>
          ) : (
            <NativeSymbol ios="square.grid.2x2" android="apps-outline" size={18} />
          )}
        </Pressable>
      </GlassSurface>
    </View>
  );
}

/**
 * The apps already connected. The catalog call reconciles connection
 * rows, so the list is read after it. Read again whenever the footer mounts (Android unmounts it
 * behind settings pages) and after leaving the apps screen.
 */
function useConnectedAppMarks() {
  const catalogRead = rpcQuery("connections/catalog");
  const listRead = rpcQuery("connections/list");
  const marks = useQuery(
    {
      queryKey: [...listRead.queryKey, "connections/catalog"],
      queryFn: async (context) => {
        const catalog = await catalogRead.queryFn(
          context as Parameters<typeof catalogRead.queryFn>[0],
        );
        const connections = await listRead.queryFn(
          context as Parameters<typeof listRead.queryFn>[0],
        );
        return connectedAppMarks(catalog, connections, { suggest: false });
      },
      refetchOnMount: "always",
    },
    queryClient,
  );
  const { refetch } = marks;
  const pathname = usePathname();
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === INTEGRATIONS_PATH && pathname !== INTEGRATIONS_PATH) void refetch();
    previous.current = pathname;
  }, [pathname, refetch]);
  return marks.data ?? [];
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    footer: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: 8,
    },
    apps: { height: 44, justifyContent: "center" },
    appsButton: {
      minWidth: 40,
      height: 40,
      margin: 2,
      borderRadius: 20,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 7,
    },
    mark: {
      width: MARK_SIZE,
      height: MARK_SIZE,
      borderRadius: 7,
      overflow: "hidden",
      // Logos are drawn for a light plate, as link favicons are.
      backgroundColor: tokens.faviconPlate,
    },
    overlap: { marginLeft: -6 },
    plus: {
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.card,
    },
  });
}
