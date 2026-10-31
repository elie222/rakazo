import { MenuView } from "@expo/ui/community/menu";
import type { Ticket, TicketStatus } from "@rakazo/contracts";
import { TICKET_STATUSES } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { rpc } from "../lib/api";
import { boardSections, ticketStatusLabel } from "../lib/board";
import { useI18n } from "../lib/i18n";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

/** The Space's ticket board: every column, with the status changed in place. */
export default function BoardScreen() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const sideInsets = useSideInsets();
  const colorScheme = useResolvedAppearance();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const { tickets: rows } = await rpc("tickets/list", {});
      if (!live.current) return;
      setTickets(rows);
      setError("");
    } catch (cause) {
      if (!live.current) return;
      setError(errorText(cause, t("Try again.")));
    } finally {
      if (live.current) setLoading(false);
    }
  }, [t]);

  useFocusEffect(
    useCallback(() => {
      live.current = true;
      void load();
      return () => {
        live.current = false;
      };
    }, [load]),
  );

  async function move(ticket: Ticket, status: TicketStatus) {
    try {
      const updated = await rpc("tickets/move", { id: ticket.id, status });
      if (live.current)
        setTickets((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
    } catch (cause) {
      Alert.alert(t("Could not move the ticket"), errorText(cause, t("Try again.")));
    }
  }

  const sections = boardSections(tickets).map((section) => ({
    title: ticketStatusLabel(section.status, t),
    data: section.tickets,
  }));

  return (
    <SafeAreaView edges={["left", "right"]} style={styles.screen}>
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : (
        <SectionList
          contentContainerStyle={[styles.content, sideInsets]}
          keyExtractor={(ticket) => ticket.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load().finally(() => setRefreshing(false));
              }}
            />
          }
          renderItem={({ item }) => (
            <MenuView
              actions={TICKET_STATUSES.filter((status) => status !== item.status).map((status) => ({
                id: `status:${status}`,
                title: ticketStatusLabel(status, t),
              }))}
              colorScheme={colorScheme}
              onPressAction={(event) => {
                const id = event.nativeEvent.event;
                if (id.startsWith("status:"))
                  void move(item, id.slice("status:".length) as TicketStatus);
              }}
              title={t("Move to")}
            >
              <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <Text style={styles.ref}>{item.ref}</Text>
                <Text numberOfLines={2} style={styles.title}>
                  {item.title}
                </Text>
              </Pressable>
            </MenuView>
          )}
          renderSectionHeader={({ section }) => <Text style={styles.heading}>{section.title}</Text>}
          sections={sections}
          stickySectionHeadersEnabled={false}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.empty}>{error || t("No tickets yet.")}</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { paddingVertical: 8, flexGrow: 1 },
    centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
    heading: {
      color: native.secondaryLabel,
      fontSize: 13,
      fontWeight: "600",
      textTransform: "uppercase",
      paddingHorizontal: 16,
      paddingTop: 20,
      paddingBottom: 8,
    },
    row: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 2,
      backgroundColor: native.page,
    },
    pressed: { backgroundColor: native.fillPressed },
    ref: { color: native.tertiaryLabel, fontSize: 12, fontVariant: ["tabular-nums"] },
    title: { color: native.label, fontSize: 16 },
    empty: { color: native.secondaryLabel, fontSize: 15, textAlign: "center" },
  });
}
