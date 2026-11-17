import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MemoryDocument } from "@rakazo/contracts";
import { isDeletableMemoryDocument } from "@rakazo/contracts";
import { fetchFresh } from "@rakazo/core/query";
import { useLocalSearchParams, usePreventRemove, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { mobileTokens } from "../../lib/appearance";
import { native, useThemedStyles } from "../../lib/native";
import { formRead, queryClient, rpcQuery, useSave } from "../../lib/query";
import { useScreenHeader } from "../../lib/screen-header";
import { useScreenQuery } from "../../lib/screen-query";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** One memory note: a bot's when opened with its id, otherwise one shared by the space's bots. */
export default function MemoryNoteScreen() {
  const params = useLocalSearchParams<{ id: string; botId?: string }>();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const [note, setNote] = useState<MemoryDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [gone, setGone] = useState(false);
  const [closing, setClosing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const { id, botId } = params;

  // There is no single-note read, so find the note in its bot's or the space's list.
  const botList = formRead(
    rpcQuery("memory/list", botId ? { botId, scope: "bot" } : { scope: "user" }),
  );
  // Each note reads the list afresh: another note's read is not this one as it is now.
  const listRead = {
    ...botList,
    queryKey: [...botList.queryKey, id] as unknown as typeof botList.queryKey,
  };
  const listQuery = useScreenQuery(listRead, { onForeground: false });
  const { refetch } = listQuery;
  // Only what this visit read: a copy an earlier one left is not the note as it is now.
  const listed =
    listQuery.isFetchedAfterMount && listQuery.status === "success" ? listQuery.data : undefined;

  // A different note in the same screen starts from its own content, never the previous one's.
  const [shown, setShown] = useState<string | null>(null);
  const key = `${botId ?? ""}:${id}`;
  if (shown !== null && shown !== key) {
    setShown(null);
    setNote(null);
    setDraft("");
    setGone(false);
  }
  useEffect(() => {
    if (!listed || shown === key) return;
    const found = listed.find((doc) => doc.id === id);
    setShown(key);
    if (!found) return setGone(true);
    setNote(found);
    setDraft(found.content);
  }, [listed, shown, key, id]);

  const saving = useSave({
    save: async (
      input: { documentId: string; content: string; expectedRevision?: number },
      send,
    ): Promise<
      { kind: "saved"; note: MemoryDocument } | { kind: "changed"; latest?: MemoryDocument }
    > => {
      try {
        return { kind: "saved", note: await send("memory/update", input) };
      } catch (reason) {
        if (errorCode(reason) === "NOT_FOUND") return { kind: "changed" };
        if (errorCode(reason) !== "CONFLICT") throw reason;
        const latest = await fetchFresh(queryClient, listRead).catch(() => {
          throw new Error(t`Could not save`);
        });
        return { kind: "changed", latest: latest.find((doc) => doc.id === input.documentId) };
      }
    },
    onSaved: (outcome) => {
      if (outcome.kind === "saved") {
        setNote(outcome.note);
        setClosing(true);
      } else if (!outcome.latest) setGone(true);
      else offerLatest(outcome.latest);
    },
  });
  const removal = useSave({
    save: async (documentId: string, send) => {
      // Already deleted elsewhere: the outcome asked for.
      await send("memory/remove", { documentId }).catch((reason: unknown) => {
        if (errorCode(reason) !== "NOT_FOUND") throw reason;
      });
    },
    onSaved: () => setClosing(true),
    closesScreen: true,
  });
  const busy = saving.pending || removal.pending;
  const loadFailed = Boolean(listQuery.error) && !listQuery.isFetching && !note && !gone;
  const state = gone ? "gone" : note ? "ready" : loadFailed ? "failed" : "loading";
  const error = loadFailed
    ? errorText(listQuery.error, t`Could not load memory`)
    : saving.error
      ? errorText(saving.error, t`Could not save`)
      : removal.error
        ? errorText(removal.error, t`Could not delete note`)
        : null;

  useEffect(() => {
    if (closing) router.back();
  }, [closing, router]);

  const dirty = Boolean(note) && draft !== note?.content;
  // A note deleted elsewhere keeps its draft on screen, read-only, with nothing left to save,
  // and leaving still asks before the draft is lost.
  const writable = state === "ready" && !busy && !closing;
  usePreventRemove(dirty && !closing && !discarding, ({ repeat }) => {
    // A save in flight decides the outcome; discarding now could not stop it.
    if (busy) return;
    Alert.alert(t`Discard changes?`, undefined, [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Discard`,
        style: "destructive",
        onPress: () => {
          setDiscarding(true);
          repeat();
        },
      },
    ]);
  });

  function offerLatest(found: MemoryDocument) {
    // The edit stays in the editor until its author picks which version wins.
    Alert.alert(t`This note changed`, undefined, [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Use latest`,
        onPress: () => {
          setNote(found);
          setDraft(found.content);
        },
      },
      {
        text: t`Save mine`,
        style: "destructive",
        onPress: () => save(found.revision),
      },
    ]);
  }

  function save(expectedRevision = note?.revision) {
    if (!note) return;
    removal.reset();
    saving.run({ documentId: note.id, content: draft, expectedRevision });
  }

  function confirmDelete() {
    if (!note) return;
    Alert.alert(t`Delete ${ph({ name: note.path })}?`, undefined, [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Delete`,
        style: "destructive",
        onPress: () => {
          saving.reset();
          removal.run(note.id);
        },
      },
    ]);
  }

  useScreenHeader({
    title: note?.path ?? "",
    action:
      !note || state === "gone"
        ? null
        : { label: t`Save`, disabled: !(dirty && writable), onPress: () => save() },
  });

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {state === "loading" ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
        ) : null}
        {note ? (
          <TextInput
            value={draft}
            onChangeText={setDraft}
            accessibilityLabel={note.path}
            editable={writable}
            multiline
            textAlignVertical="top"
            style={styles.editor}
          />
        ) : null}
        {state === "gone" ? (
          <Text style={styles.secondary}>{t`This note no longer exists`}</Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {state === "failed" ? (
          <NativeActionButton
            fill={false}
            label={t`Retry`}
            onPress={() => void refetch()}
            prominence="secondary"
          />
        ) : null}
        {note && state !== "gone" && isDeletableMemoryDocument(note.path) ? (
          <NativeActionButton
            disabled={busy || closing}
            fill={false}
            label={t`Delete`}
            onPress={confirmDelete}
            prominence="destructive"
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 16, gap: 14 },
    editor: {
      minHeight: 320,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      padding: 14,
      fontSize: 15,
      lineHeight: 21,
    },
    secondary: { color: native.secondaryLabel, fontSize: 15 },
    error: { color: mobileTokens().destructive, fontSize: 13 },
  });
}
