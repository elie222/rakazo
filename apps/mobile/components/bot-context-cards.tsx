import { useLingui } from "@lingui/react/macro";
import type { MemoryDocument, ScratchpadItem } from "@rakazo/contracts";
import { isEmptyBotMemory } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeSymbol } from "./native-symbol";
import { useTextEditDialog } from "./profile-edit-dialog";

export function BotContextCards({ botId }: { botId: string }) {
  const { t } = useLingui();
  const router = useRouter();
  const tokens = useMobileTokens();
  const [work, setWork] = useState<ScratchpadItem[]>([]);
  const [docs, setDocs] = useState<MemoryDocument[]>([]);
  const [allWork, setAllWork] = useState(false);
  const [allDocs, setAllDocs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reload on return, so an edited or deleted note shows its saved state.
  useFocusEffect(
    useCallback(() => {
      let current = true;
      setError(null);
      void rpc("scratchpad/list", { botId })
        .then((items) => {
          if (current) setWork(items);
        })
        .catch((err) => {
          if (current) setError(errorText(err));
        });
      void rpc("memory/list", { botId, scope: "bot" })
        .then((documents) => {
          if (current) setDocs(documents.filter((doc) => !isEmptyBotMemory(doc)));
        })
        .catch((err) => {
          if (current) setError(errorText(err));
        });
      return () => {
        current = false;
      };
    }, [botId]),
  );
  const addWork = useTextEditDialog(t`Add open work`, 200);
  async function createWork(title: string) {
    if (!title || busy) return;
    setBusy(true);
    try {
      const item = await rpc("scratchpad/create", { botId, title });
      setWork((items) => [item, ...items]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  const heading = { color: tokens.mutedForeground, ...typeScale.secondary, paddingStart: 20 };
  const card = {
    backgroundColor: tokens.card,
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 22,
    borderCurve: "continuous" as const,
    overflow: "hidden" as const,
  };
  // Rows inset to the group's text edge, a hairline between each, as in the shared settings groups.
  const row = (index: number) => ({
    minHeight: 60,
    paddingStart: 20,
    paddingEnd: 16,
    paddingVertical: 14,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 14,
    ...(index > 0 ? { borderTopWidth: 1, borderTopColor: tokens.border } : null),
  });
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
              onPress={() => addWork.ask("", (title) => void createWork(title))}
            >
              <NativeSymbol ios="plus" android="add" size={18} color={tokens.mutedForeground} />
            </Pressable>
          </View>
          <View style={card}>
            {(allWork ? work : work.slice(0, 5)).map((item, index) => (
              <View key={item.id} style={row(index)}>
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
                  onPress={() => {
                    setBusy(true);
                    void rpc("scratchpad/update", { itemId: item.id, status: "done" })
                      .then(() => setWork((items) => items.filter((entry) => entry.id !== item.id)))
                      .catch((err) => setError(errorText(err)))
                      .finally(() => setBusy(false));
                  }}
                >
                  <NativeSymbol
                    ios="circle"
                    android="ellipse-outline"
                    size={22}
                    color={tokens.mutedForeground}
                  />
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: tokens.foreground, ...rowTitle }}>{item.title}</Text>
                  {item.notes ? (
                    <Text
                      style={{ color: tokens.mutedForeground, ...typeScale.caption, marginTop: 2 }}
                    >
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
                style={[row(1), { justifyContent: "center" }]}
              >
                <Text style={{ color: tokens.mutedForeground }}>{t`Show more`}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
      {addWork.dialog}
      {docs.length ? (
        <View style={{ marginTop: 24 }}>
          <Text accessibilityRole="header" style={[heading, { marginBottom: 8 }]}>
            {t`Memory`}
          </Text>
          <View style={card}>
            {(allDocs ? docs : docs.slice(0, 5)).map((doc, index) => (
              <Pressable
                key={doc.id}
                accessibilityRole="button"
                accessibilityLabel={doc.path}
                onPress={() =>
                  router.push({ pathname: "/memory-note", params: { id: doc.id, botId } })
                }
                style={row(index)}
              >
                <Text numberOfLines={1} style={{ color: tokens.foreground, ...rowTitle, flex: 1 }}>
                  {doc.path}
                </Text>
                <NativeSymbol
                  ios="chevron.right"
                  android="chevron-forward"
                  size={16}
                  color={tokens.mutedForeground}
                />
              </Pressable>
            ))}
            {!allDocs && docs.length > 5 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setAllDocs(true)}
                style={[row(1), { justifyContent: "center" }]}
              >
                <Text style={{ color: tokens.mutedForeground }}>{t`Show more`}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
      {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
    </>
  );
}

/** A row title in the grouped lists. */
const rowTitle = { fontSize: 17, lineHeight: 24 };
