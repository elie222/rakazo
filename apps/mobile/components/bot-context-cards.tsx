import { useLingui } from "@lingui/react/macro";
import { isEmptyBotMemory } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { native, useMobileTokens } from "../lib/native";
import { queryClient, rpcQuery, useSave } from "../lib/query";
import { useScreenQuery } from "../lib/screen-query";
import { errorText } from "../lib/user-error";
import { NativeSymbol } from "./native-symbol";
import { useTextEditDialog } from "./profile-edit-dialog";
import { SettingsGroup, SettingsRow } from "./settings-group";

/** A bot's open work, or its memory notes; each shows only once it has something. */
export function BotContextCards({ botId, section }: { botId: string; section: "work" | "memory" }) {
  const { t } = useLingui();
  const router = useRouter();
  const tokens = useMobileTokens();
  const [allWork, setAllWork] = useState(false);
  const [allDocs, setAllDocs] = useState(false);
  // Read again on return, so an edited or deleted note shows its saved state.
  const workRead = rpcQuery("scratchpad/list", { botId });
  const workQuery = useScreenQuery(workRead, {
    enabled: section === "work",
    onForeground: false,
  });
  const docsQuery = useScreenQuery(rpcQuery("memory/list", { botId, scope: "bot" }), {
    enabled: section === "memory",
    onForeground: false,
  });
  const work = (section === "work" && workQuery.data) || [];
  const docs = useMemo(
    () =>
      (section === "memory" ? (docsQuery.data ?? []) : []).filter((doc) => !isEmptyBotMemory(doc)),
    [section, docsQuery.data],
  );
  const change = useSave({
    save: async (
      action: { kind: "create"; title: string } | { kind: "complete"; itemId: string },
      send,
    ) => {
      if (action.kind === "create") {
        const item = await send("scratchpad/create", { botId, title: action.title });
        await writeSaved(queryClient, workRead.queryKey, (items) => [item, ...(items ?? [])]);
      } else {
        await send("scratchpad/update", { itemId: action.itemId, status: "done" });
        await writeSaved(queryClient, workRead.queryKey, (items) =>
          (items ?? []).filter((entry) => entry.id !== action.itemId),
        );
      }
    },
  });
  // A failed add or complete is not shown again on return, as the lists are read again then.
  const { reset } = change;
  useFocusEffect(useCallback(() => reset(), [reset]));
  const busy = change.pending;
  const readError = section === "work" ? workQuery.error : docsQuery.error;
  const failure = change.error ?? readError;
  const error = failure ? errorText(failure) : null;
  const addWork = useTextEditDialog(t`Add open work`, 200);
  function createWork(title: string) {
    if (title && !busy) change.run({ kind: "create", title });
  }
  const heading = { color: tokens.mutedForeground, fontSize: 12, fontWeight: "500" as const };
  const card = { backgroundColor: native.fill, borderRadius: 12, padding: 16, gap: 12 };
  return (
    <>
      {work.length ? (
        <View style={{ marginTop: 24 }}>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
              paddingEnd: 16,
            }}
          >
            <Text accessibilityRole="header" style={heading}>
              {t`Open work`}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t`Add open work`}
              style={{
                minHeight: 44,
                minWidth: 44,
                justifyContent: "center",
                alignItems: "flex-end",
              }}
              onPress={() => addWork.ask("", createWork)}
            >
              <NativeSymbol ios="plus" android="add" size={18} color={tokens.mutedForeground} />
            </Pressable>
          </View>
          <View style={card}>
            {(allWork ? work : work.slice(0, 5)).map((item) => (
              <View
                key={item.id}
                style={{ minHeight: 44, flexDirection: "row", gap: 12, alignItems: "center" }}
              >
                <Pressable
                  accessibilityLabel={`${t`Complete`} ${item.title}`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: false }}
                  hitSlop={11}
                  style={{
                    width: 22,
                    minHeight: 22,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  disabled={busy}
                  onPress={() => change.run({ kind: "complete", itemId: item.id })}
                >
                  <NativeSymbol
                    ios="circle"
                    android="ellipse-outline"
                    size={22}
                    color={tokens.mutedForeground}
                  />
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: tokens.foreground, fontSize: 14 }}>{item.title}</Text>
                  {item.notes ? (
                    <Text style={{ color: tokens.mutedForeground, fontSize: 12, marginTop: 4 }}>
                      {item.notes}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
            {!allWork && work.length > 5 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setAllWork(true)}
                style={{ minHeight: 44, alignItems: "center", justifyContent: "center" }}
              >
                <Text style={{ color: tokens.mutedForeground }}>{t`Show more`}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
      {addWork.dialog}
      {docs.length ? (
        <View style={{ marginTop: section === "memory" ? 0 : 24 }}>
          <SettingsGroup label={t`Memory`}>
            {(allDocs ? docs : docs.slice(0, 5)).map((doc) => (
              <SettingsRow
                key={doc.id}
                accessibilityRole="button"
                title={doc.path}
                chevron="right"
                onPress={() =>
                  router.push({ pathname: "/memory-note", params: { id: doc.id, botId } })
                }
              />
            ))}
            {!allDocs && docs.length > 5 ? (
              <SettingsRow
                key="show-more"
                accessibilityRole="button"
                title={t`Show more`}
                dimmed
                onPress={() => setAllDocs(true)}
              />
            ) : null}
          </SettingsGroup>
        </View>
      ) : null}
      {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
    </>
  );
}
