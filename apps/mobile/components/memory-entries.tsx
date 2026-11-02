import type { MemoryDocument, RpcOutput } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Alert, Modal, ScrollView, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { memoryEntries } from "../lib/memory-entries";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { ProfileEditDialog } from "./profile-edit-dialog";

export function MemoryEntries({
  initial,
  botId,
  onClose,
  onUpdate,
  onRefresh,
}: {
  initial: MemoryDocument | null;
  botId: string;
  onClose: () => void;
  onUpdate: (doc: MemoryDocument) => void;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [doc, setDoc] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [undoRevision, setUndoRevision] = useState<number | null>(null);
  const [prompt, setPrompt] = useState<RpcOutput<"memory/prompt"> | null>(null);
  useEffect(() => {
    if (initial) return;
    let current = true;
    setBusy(true);
    void rpc("memory/prompt", { botId })
      .then((result) => {
        if (current) setPrompt(result);
      })
      .catch((error) => {
        if (current) Alert.alert(t("Could not load"), errorText(error, t("Try again.")));
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [botId, initial, t]);
  async function changed(error: unknown) {
    await onRefresh().catch(() => undefined);
    Alert.alert(t("Could not save"), errorText(error, t("Try again.")));
    onClose();
  }
  async function replace(entry: { start: number; end: number; text: string }, replacement: string) {
    if (!doc || busy || replacement === entry.text) return;
    setBusy(true);
    try {
      const updated = await rpc("memory/editEntry", {
        documentId: doc.id,
        expectedRevision: doc.revision,
        start: entry.start,
        end: entry.end,
        expected: entry.text,
        replacement,
      });
      setDoc(updated);
      onUpdate(updated);
      setUndoRevision(updated.revision);
      setPrompt(null);
    } catch (error) {
      await changed(error);
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    if (!doc || busy || undoRevision === null) return;
    setBusy(true);
    try {
      const updated = await rpc("memory/undoEntry", {
        documentId: doc.id,
        expectedRevision: undoRevision,
      });
      setDoc(updated);
      onUpdate(updated);
      setUndoRevision(null);
      setPrompt(null);
    } catch (error) {
      await changed(error);
    } finally {
      setBusy(false);
    }
  }
  function remove(entry: { start: number; end: number; text: string }) {
    Alert.alert(t("Delete memory?"), entry.text, [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Delete"), style: "destructive", onPress: () => void replace(entry, "") },
    ]);
  }
  return (
    <Modal visible presentationStyle="pageSheet" animationType="slide" onRequestClose={onClose}>
      <ScrollView
        contentContainerStyle={{ padding: 24, gap: 16, backgroundColor: tokens.background }}
      >
        <Text accessibilityRole="header" style={{ color: tokens.foreground, fontSize: 20 }}>
          {doc?.path ?? t("Memory")}
        </Text>
        <NativeActionButton label={t("Close")} onPress={onClose} prominence="plain" />
        <NativeActionButton
          label={t("View prompt memory")}
          disabled={busy}
          onPress={() => {
            setBusy(true);
            void rpc("memory/prompt", { botId })
              .then(setPrompt)
              .catch((error) => Alert.alert(t("Could not load"), errorText(error, t("Try again."))))
              .finally(() => setBusy(false));
          }}
          prominence="plain"
        />
        {prompt ? (
          <>
            <Text style={{ color: tokens.mutedForeground }}>
              {t("{used} / {limit} bytes", { used: prompt.usedBytes, limit: prompt.limitBytes })}
            </Text>
            <Text selectable style={{ color: tokens.foreground }}>
              {prompt.text}
            </Text>
          </>
        ) : null}
        {undoRevision !== null ? (
          <NativeActionButton
            label={t("Undo")}
            disabled={busy}
            onPress={() => void undo()}
            prominence="plain"
          />
        ) : null}
        {memoryEntries(doc?.content ?? "").map((entry) => (
          <View key={entry.start} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <ProfileEditDialog
                value={entry.text}
                label={t("Edit memory")}
                editLabel={t("Edit {entry}", { entry: entry.text })}
                maxLength={100000}
                preserveWhitespace
                onCommit={(next) => (next ? replace(entry, next) : Promise.resolve(remove(entry)))}
              />
            </View>
            <NativeActionButton
              label={t("Delete")}
              accessibilityLabel={t("Delete {entry}", { entry: entry.text })}
              disabled={busy}
              prominence="plain"
              onPress={() => remove(entry)}
            />
          </View>
        ))}
      </ScrollView>
    </Modal>
  );
}
