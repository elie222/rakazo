import type { Ticket, TicketStatus } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { BoardList } from "../components/board-list";
import { rpc } from "../lib/api";
import { boardSections } from "../lib/board";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

/** The Space's ticket board: every column, with the status changed in place. */
export default function BoardScreen() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const sideInsets = useSideInsets();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const live = useRef(true);
  // A load that started before a later load, a move, or a blur must not overwrite newer rows.
  const generation = useRef(0);
  const moving = useRef(new Set<string>());

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const { tickets: rows } = await rpc("tickets/list", {});
      if (current !== generation.current) return;
      setTickets(rows);
      setError("");
    } catch (cause) {
      if (current !== generation.current) return;
      setError(errorText(cause, t("Try again.")));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [t]);

  useFocusEffect(
    useCallback(() => {
      live.current = true;
      void load();
      return () => {
        live.current = false;
        generation.current += 1;
      };
    }, [load]),
  );

  async function move(ticket: Ticket, status: TicketStatus) {
    if (moving.current.has(ticket.id)) return;
    moving.current.add(ticket.id);
    generation.current += 1;
    try {
      const updated = await rpc("tickets/move", { id: ticket.id, status });
      // A refresh that started while the move was in flight may have read the old status.
      generation.current += 1;
      if (live.current)
        setTickets((rows) => [updated, ...rows.filter((row) => row.id !== updated.id)]);
    } catch (cause) {
      Alert.alert(t("Could not move the ticket"), errorText(cause, t("Try again.")));
    } finally {
      moving.current.delete(ticket.id);
    }
  }

  if (loading || tickets.length === 0) {
    return (
      <View style={[styles.centered, sideInsets]}>
        {loading ? (
          <ActivityIndicator color={native.secondaryLabel} />
        ) : (
          <Text style={styles.message}>{error || t("No tickets yet.")}</Text>
        )}
      </View>
    );
  }
  return (
    <BoardList
      sections={boardSections(tickets)}
      error={error}
      onMove={(ticket, status) => void move(ticket, status)}
      onRefresh={load}
    />
  );
}

function createStyles() {
  return StyleSheet.create({
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 32,
      backgroundColor: native.groupedPage,
    },
    message: { color: native.secondaryLabel, fontSize: 17, textAlign: "center" },
  });
}
