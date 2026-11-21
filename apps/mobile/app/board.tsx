import { useLingui } from "@lingui/react/macro";
import type { Ticket, TicketStatus } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { LoadFailure } from "../components/ui/load-failure";
import { rpc } from "../lib/api/api";
import { errorText } from "../lib/api/user-error";
import { boardSections } from "../lib/board/board";
import { BoardList } from "../lib/board/board-list";
import { useSideInsets } from "../lib/layout/side-insets";
import { native, useThemedStyles } from "../lib/native/native";

/** The Space's ticket board: every column, with the status changed in place. */
export default function BoardScreen() {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const sideInsets = useSideInsets();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [error, setError] = useState("");
  const [refreshFailures, setRefreshFailures] = useState(0);
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
      setError(errorText(cause, t`Try again.`));
      setRefreshFailures((count) => count + 1);
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
      Alert.alert(t`Could not move the ticket`, errorText(cause, t`Try again.`));
    } finally {
      moving.current.delete(ticket.id);
    }
  }

  if (loading || tickets.length === 0) {
    return (
      <View style={[styles.centered, sideInsets]}>
        {loading ? (
          <ActivityIndicator color={native.secondaryLabel} />
        ) : error ? (
          <LoadFailure
            message={error}
            onRetry={() => {
              setLoading(true);
              void load();
            }}
          />
        ) : (
          <Text style={styles.message}>{t`No tickets yet.`}</Text>
        )}
      </View>
    );
  }
  return (
    <BoardList
      sections={boardSections(tickets)}
      error={error}
      refreshFailures={refreshFailures}
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
