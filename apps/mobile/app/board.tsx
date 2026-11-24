import { useLingui } from "@lingui/react/macro";
import type { TicketListScope, TicketStatus } from "@rakazo/contracts";
import { TICKET_LIST_SCOPES, ticketInScope } from "@rakazo/contracts";
import { useState } from "react";
import { ActivityIndicator, Alert, Platform, StyleSheet, Text, View } from "react-native";
import { NativeActionButton } from "../components/native/native-action-button";
import { LoadFailure } from "../components/ui/load-failure";
import { useSpaceChanges } from "../lib/api/roster-signals";
import { errorText } from "../lib/api/user-error";
import { boardSections } from "../lib/board/board";
import { BoardList } from "../lib/board/board-list";
import { useSideInsets } from "../lib/layout/side-insets";
import { showIOSActionSheet } from "../lib/native/ios-action-sheet";
import { native, useThemedStyles } from "../lib/native/native";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { queryClient, refreshRpcQueries, rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

export default function BoardScreen() {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const sideInsets = useSideInsets();
  const [refreshingEmpty, setRefreshingEmpty] = useState(false);
  const [scope, setScope] = useState<TicketListScope>("board");
  const listRead = rpcQuery("tickets/list", scope === "board" ? {} : { scope });
  const list = useScreenQuery(listRead);
  const change = useSave({
    save: async (
      change: { id: string } & ({ status: TicketStatus } | { archived: boolean }),
      send,
    ) => {
      const before = queryClient
        .getQueryData(listRead.queryKey)
        ?.tickets.find((ticket) => ticket.id === change.id);
      const updated =
        "status" in change
          ? await send("tickets/move", change)
          : await send("tickets/update", change);
      queryClient.setQueryData(listRead.queryKey, (current) =>
        before && current?.tickets.includes(before)
          ? {
              ...current,
              tickets: [
                ...(ticketInScope(updated, scope) ? [updated] : []),
                ...current.tickets.filter((row) => row.id !== updated.id),
              ],
            }
          : undefined,
      );
    },
    stale: [listRead.queryKey.slice(0, -1)],
    onFailed: (cause, input) =>
      Alert.alert(
        "status" in input
          ? t`Could not move the ticket`
          : input.archived
            ? t`Could not archive the ticket`
            : t`Could not restore the ticket`,
        errorText(cause, t`Try again.`),
      ),
  });
  useSpaceChanges("board", () => refreshRpcQueries("tickets/list"), true);
  const labels = {
    board: t`All on board`,
    open: t`Open tickets`,
    archived: t`Archived`,
  };
  useScreenHeader({
    action: {
      label: labels[scope],
      prominence: "secondary",
      onPress: () => {
        if (Platform.OS === "ios") {
          showIOSActionSheet(
            {
              title: t`Filter tickets`,
              options: [...TICKET_LIST_SCOPES.map((value) => labels[value]), t`Cancel`],
              cancelButtonIndex: TICKET_LIST_SCOPES.length,
            },
            (index) => {
              const next = TICKET_LIST_SCOPES[index];
              if (next) setScope(next);
            },
          );
          return;
        }
        Alert.alert(
          t`Filter tickets`,
          undefined,
          TICKET_LIST_SCOPES.map((value) => ({
            text: labels[value],
            onPress: () => setScope(value),
          })),
          { cancelable: true },
        );
      },
    },
  });
  // Older servers ignore the scope, and omit archivedAt on all their tickets.
  const tickets = list.data?.tickets.filter((ticket) => ticketInScope(ticket, scope));
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
            <Text style={styles.message}>
              {scope === "board" ? t`No tickets yet.` : t`No matching tickets`}
            </Text>
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
      moving={change.pending}
      onMove={(ticket, status) => change.run({ id: ticket.id, status })}
      onArchive={(ticket) => change.run({ id: ticket.id, archived: !ticket.archivedAt })}
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
