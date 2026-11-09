import type { MemoryDocument } from "@rakazo/contracts";
import { isDeletableMemoryDocument } from "@rakazo/contracts";
import type { NativeStackNavigationOptions } from "expo-router";
import { useLocalSearchParams, useNavigation, usePreventRemove, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { iosAtLeast } from "../../lib/native-controls";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** One memory note: a bot's when opened with its id, otherwise one shared by the space's bots. */
export default function MemoryNoteScreen() {
  const params = useLocalSearchParams<{ id: string; botId?: string }>();
  const navigation = useNavigation();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const [note, setNote] = useState<MemoryDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "failed" | "gone">("loading");
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);
  const { id, botId } = params;

  // There is no single-note read, so find the note in its bot's or the space's list.
  const latest = async () =>
    (await rpc("memory/list", botId ? { botId, scope: "bot" } : { scope: "user" })).find(
      (doc) => doc.id === id,
    );
  const latestRef = useRef(latest);
  latestRef.current = latest;

  // A different note in the same screen starts from its own content, never the previous one's.
  useEffect(() => {
    live.current = true;
    setNote(null);
    setDraft("");
    setState("loading");
    setError(null);
    latestRef
      .current()
      .then((found) => {
        if (!live.current) return;
        if (!found) return setState("gone");
        setNote(found);
        setDraft(found.content);
        setState("ready");
      })
      .catch((reason) => {
        if (!live.current) return;
        setError(errorText(reason, t("Could not load memory")));
        setState("failed");
      });
    return () => {
      live.current = false;
    };
  }, [id, botId, t, attempt]);

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
    Alert.alert(t("Discard changes?"), undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Discard"),
        style: "destructive",
        onPress: () => {
          setDiscarding(true);
          repeat();
        },
      },
    ]);
  });

  async function offerLatest() {
    const found = await latestRef.current().catch(() => null);
    if (!live.current) return;
    if (found === null) return setError(t("Could not save"));
    if (!found) return setState("gone");
    // The edit stays in the editor until its author picks which version wins.
    Alert.alert(t("This note changed"), undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Use latest"),
        onPress: () => {
          setNote(found);
          setDraft(found.content);
        },
      },
      {
        text: t("Save mine"),
        style: "destructive",
        onPress: () => void saveRef.current(found.revision),
      },
    ]);
  }

  async function save(expectedRevision = note?.revision) {
    if (!note) return;
    setBusy(true);
    setError(null);
    try {
      setNote(
        await rpc("memory/update", { documentId: note.id, content: draft, expectedRevision }),
      );
      if (live.current) setClosing(true);
    } catch (reason) {
      if (!live.current) return;
      if (errorCode(reason) === "CONFLICT") await offerLatest();
      else if (errorCode(reason) === "NOT_FOUND") setState("gone");
      else setError(errorText(reason, t("Could not save")));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const saveRef = useRef(save);
  saveRef.current = save;

  function confirmDelete() {
    if (!note) return;
    Alert.alert(t("Delete {name}?", { name: note.path }), undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          setError(null);
          rpc("memory/remove", { documentId: note.id })
            .then(() => {
              if (live.current) setClosing(true);
            })
            .catch((reason) => {
              if (!live.current) return;
              // Already deleted elsewhere: the outcome asked for.
              if (errorCode(reason) === "NOT_FOUND") return setClosing(true);
              setError(errorText(reason, t("Could not delete note")));
              setBusy(false);
            });
        },
      },
    ]);
  }

  const canSave = dirty && writable;
  useLayoutEffect(() => {
    navigation.setOptions({
      title: note?.path ?? "",
      ...(!note || state === "gone"
        ? { headerRight: undefined, unstable_headerRightItems: undefined }
        : iosAtLeast(26)
          ? {
              unstable_headerRightItems: () => [
                {
                  type: "button" as const,
                  label: t("Save"),
                  variant: "prominent" as const,
                  tintColor: mobileTokens().primary,
                  disabled: !canSave,
                  onPress: () => void saveRef.current(),
                },
              ],
            }
          : {
              headerRight: () => (
                <NativeActionButton
                  disabled={!canSave}
                  fill={false}
                  label={t("Save")}
                  onPress={() => void saveRef.current()}
                />
              ),
            }),
    } satisfies NativeStackNavigationOptions);
  }, [navigation, note, state, canSave, t]);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {state === "loading" ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t("Loading…")} />
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
          <Text style={styles.secondary}>{t("This note no longer exists")}</Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {state === "failed" ? (
          <NativeActionButton
            fill={false}
            label={t("Retry")}
            onPress={() => setAttempt((count) => count + 1)}
            prominence="secondary"
          />
        ) : null}
        {note && state !== "gone" && isDeletableMemoryDocument(note.path) ? (
          <NativeActionButton
            disabled={busy || closing}
            fill={false}
            label={t("Delete")}
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
