import { useLingui } from "@lingui/react/macro";
import type { Ticket, TicketStatus } from "@rakazo/contracts";
import { useRef } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { LoadFailure } from "../components/ui/load-failure";
import { errorText } from "../lib/api/user-error";
import { boardSections } from "../lib/board/board";
import { BoardList } from "../lib/board/board-list";
import { useSideInsets } from "../lib/layout/side-insets";
import { native, useThemedStyles } from "../lib/native/native";
import { queryClient, rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

/** The Space's ticket board: every column, with the status changed in place. */
export default function BoardScreen() {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const sideInsets = useSideInsets();
  const listRead = rpcQuery("tickets/list", {});
  const list = useScreenQuery(listRead);
  // Moves made while one saves wait their turn, so a second ticket's move is never dropped.
  const queued = useRef<{ ticket: Ticket; status: TicketStatus }[]>([]);
  const move = useSave({
    save: async (_, send) => {
      while (queued.current.length) {
        while (queued.current.length) {
          const change = queued.current.shift()!;
          try {
            const updated = await send("tickets/move", {
              id: change.ticket.id,
              status: change.status,
            });
            // The moved row stays moved even if the read after it fails.
            queryClient.setQueryData(
              listRead.queryKey,
              (current) =>
                current && {
                  ...current,
                  tickets: [updated, ...current.tickets.filter((row) => row.id !== updated.id)],
                },
            );
          } catch (cause) {
            queued.current = [];
            throw cause;
          }
        }
        // A move made while the list is read again is sent next.
        await queryClient.invalidateQueries({ queryKey: listRead.queryKey });
      }
    },
    onFailed: (cause) => Alert.alert(t`Could not move the ticket`, errorText(cause, t`Try again.`)),
  });
  const tickets = list.data?.tickets;
  const error = list.error ? errorText(list.error, t`Try again.`) : "";
  const loading = !tickets && (list.isFetching || !list.error);

  if (!tickets || tickets.length === 0) {
    return (
      <View style={[styles.centered, sideInsets]}>
        {loading ? (
          <ActivityIndicator color={native.secondaryLabel} />
        ) : error ? (
          <LoadFailure message={error} onRetry={() => void list.refetch()} />
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
      refreshFailures={list.errorUpdateCount}
      onMove={(ticket, status) => {
        queued.current.push({ ticket, status });
        move.run();
      }}
      onRefresh={async () => {
        await list.refetch();
      }}
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
