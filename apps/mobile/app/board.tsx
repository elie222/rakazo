import { useLingui } from "@lingui/react/macro";
import type { Ticket, TicketStatus } from "@rakazo/contracts";
import { useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { NativeActionButton } from "../components/native/native-action-button";
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
  const [refreshingEmpty, setRefreshingEmpty] = useState(false);
  const listRead = rpcQuery("tickets/list", {});
  const list = useScreenQuery(listRead);
  const move = useSave({
    save: async (change: { ticket: Ticket; status: TicketStatus }, send) => {
      const updated = await send("tickets/move", { id: change.ticket.id, status: change.status });
      // The moved row stays moved even if the read after it fails.
      queryClient.setQueryData(
        listRead.queryKey,
        (current) =>
          current && {
            ...current,
            tickets: [updated, ...current.tickets.filter((row) => row.id !== updated.id)],
          },
      );
    },
    stale: [listRead.queryKey],
    onFailed: (cause) => Alert.alert(t`Could not move the ticket`, errorText(cause, t`Try again.`)),
  });
  const tickets = list.data?.tickets;
  const error = list.error ? errorText(list.error, t`Try again.`) : "";

  if (!tickets || tickets.length === 0) {
    const loading = !tickets && (list.isFetching || !list.error);
    async function refreshEmpty() {
      setRefreshingEmpty(true);
      try {
        await list.refetch({ cancelRefetch: false });
      } finally {
        setRefreshingEmpty(false);
      }
    }
    return (
      <View style={[styles.centered, sideInsets]}>
        {loading ? (
          <ActivityIndicator color={native.secondaryLabel} />
        ) : error ? (
          <LoadFailure message={error} onRetry={() => void list.refetch()} />
        ) : (
          <View style={styles.empty}>
            <Text style={styles.message}>{t`No tickets yet.`}</Text>
            <NativeActionButton
              label={t`Refresh`}
              busy={refreshingEmpty}
              fill={false}
              prominence="secondary"
              onPress={() => void refreshEmpty()}
            />
          </View>
        )}
      </View>
    );
  }
  return (
    <BoardList
      sections={boardSections(tickets)}
      error={error}
      refreshFailures={list.errorUpdateCount}
      moving={move.pending}
      onMove={(ticket, status) => move.run({ ticket, status })}
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
    empty: { alignItems: "center", gap: 8 },
    message: { color: native.secondaryLabel, fontSize: 17, textAlign: "center" },
  });
}
