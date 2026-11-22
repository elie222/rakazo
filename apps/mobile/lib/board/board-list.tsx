import type { MenuComponentRef } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { Ticket, TicketStatus } from "@rakazo/contracts";
import { TICKET_STATUSES } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
} from "react-native";
import {
  SettingsGroup,
  SettingsRow,
  useStackedSettings,
} from "../../components/settings/settings-group";
import type { ResolvedAppearance } from "../appearance/appearance";
import { useSideInsets } from "../layout/side-insets";
import { native, useResolvedAppearance, useThemedStyles } from "../native/native";
import type { BoardSection } from "./board";
import { boardRefreshFailure, ticketStatusLabel } from "./board";

export type BoardListProps = {
  sections: BoardSection[];
  /** A failed refresh while older tickets are still shown. */
  error: string;
  /** Counts failed loads, so a repeat of the same error is announced again. */
  refreshFailures: number;
  /** A move is saving: no other is offered until it ends. */
  moving?: boolean;
  onMove: (ticket: Ticket, status: TicketStatus) => void;
  onRefresh: () => Promise<void>;
};

/** Settings-style groups, one per column; iOS renders the same groups as a SwiftUI list. */
export function BoardList({
  sections,
  error,
  refreshFailures,
  moving = false,
  onMove,
  onRefresh,
}: BoardListProps) {
  const styles = useThemedStyles(createStyles);
  const stacked = useStackedSettings();
  const sideInsets = useSideInsets();
  const colorScheme = useResolvedAppearance();
  const [refreshing, setRefreshing] = useState(false);
  // A failed refresh leaves older tickets on screen, so tell screen readers it failed.
  useEffect(() => {
    if (error) AccessibilityInfo.announceForAccessibility(boardRefreshFailure(error));
  }, [error, refreshFailures]);
  return (
    <ScrollView
      style={[styles.screen, sideInsets]}
      contentContainerStyle={[styles.content, stacked && styles.compactContent]}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void onRefresh().finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {boardRefreshFailure(error)}
        </Text>
      ) : null}
      {sections.map((section) => (
        <SettingsGroup key={section.status} label={ticketStatusLabel(section.status)}>
          {section.tickets.map((ticket) => (
            <TicketMoveRow
              key={ticket.id}
              ticket={ticket}
              colorScheme={colorScheme}
              moving={moving}
              onMove={onMove}
            />
          ))}
        </SettingsGroup>
      ))}
    </ScrollView>
  );
}

function TicketMoveRow({
  ticket,
  colorScheme,
  moving,
  onMove,
}: Pick<BoardListProps, "onMove"> & {
  ticket: Ticket;
  colorScheme: ResolvedAppearance;
  moving: boolean;
}) {
  const { t } = useLingui();
  const menu = useRef<MenuComponentRef>(null);
  // Android's menu host handles pointer input but is not itself accessible.
  const openMenu = Platform.OS === "android" ? () => menu.current?.show() : undefined;
  if (moving) return <SettingsRow title={ticket.title} detail={ticket.ref} disabled dimmed />;
  return (
    <MenuView
      ref={menu}
      actions={TICKET_STATUSES.filter((status) => status !== ticket.status).map((status) => ({
        id: status,
        title: ticketStatusLabel(status),
      }))}
      colorScheme={colorScheme}
      onPressAction={(event) => onMove(ticket, event.nativeEvent.event as TicketStatus)}
      title={t`Move to`}
    >
      <SettingsRow
        accessibilityRole="button"
        title={ticket.title}
        detail={ticket.ref}
        onPress={openMenu}
      />
    </MenuView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },
    compactContent: { paddingHorizontal: 8 },
    error: { color: native.secondaryLabel, fontSize: 15, paddingHorizontal: 16, paddingBottom: 12 },
  });
}
