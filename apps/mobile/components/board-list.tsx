import { MenuView } from "@expo/ui/community/menu";
import type { Ticket, TicketStatus } from "@rakazo/contracts";
import { TICKET_STATUSES } from "@rakazo/contracts";
import { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import type { BoardSection } from "../lib/board";
import { ticketStatusLabel } from "../lib/board";
import { useI18n } from "../lib/i18n";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { SettingsGroup, SettingsRow, useStackedSettings } from "./settings-group";

export type BoardListProps = {
  sections: BoardSection[];
  /** A failed refresh while older tickets are still shown. */
  error: string;
  onMove: (ticket: Ticket, status: TicketStatus) => void;
  onRefresh: () => Promise<void>;
};

/** Settings-style groups, one per column; iOS renders the same groups as a SwiftUI list. */
export function BoardList({ sections, error, onMove, onRefresh }: BoardListProps) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const stacked = useStackedSettings();
  const sideInsets = useSideInsets();
  const colorScheme = useResolvedAppearance();
  const [refreshing, setRefreshing] = useState(false);
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
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {sections.map((section) => (
        <SettingsGroup key={section.status} label={ticketStatusLabel(section.status, t)}>
          {section.tickets.map((ticket) => (
            <MenuView
              key={ticket.id}
              actions={TICKET_STATUSES.filter((status) => status !== ticket.status).map(
                (status) => ({ id: status, title: ticketStatusLabel(status, t) }),
              )}
              colorScheme={colorScheme}
              onPressAction={(event) => onMove(ticket, event.nativeEvent.event as TicketStatus)}
              title={t("Move to")}
            >
              <SettingsRow accessibilityRole="button" title={ticket.title} detail={ticket.ref} />
            </MenuView>
          ))}
        </SettingsGroup>
      ))}
    </ScrollView>
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
