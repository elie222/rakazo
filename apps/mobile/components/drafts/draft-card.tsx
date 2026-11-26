import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { DraftBlock } from "@rakazo/contracts";
import type { DraftNote } from "@rakazo/core";
import {
  addDraftNote,
  draftNoteAt,
  draftNotesWithPending,
  draftRevisionText,
  draftSegments,
  newClientId,
} from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { errorText } from "../../lib/api/user-error";
import { useMobileTokens } from "../../lib/native/native";
import { useSave } from "../../lib/query/query";
import { useThreadReadOnly } from "../../lib/thread/thread-read-only";
import { NativeActionButton } from "../native/native-action-button";

const COPIED_MS = 2000;

type DraftTarget = { botId: string } | { groupId: string };

/** Copies the draft's body; the label says Copied for a moment once it is on the clipboard. */
function useCopyDraft(body: string) {
  // A new object keeps "Copied" for another COPIED_MS.
  const [copied, setCopied] = useState<object | null>(null);
  useTimeout(() => setCopied(null), copied ? COPIED_MS : null, copied);
  const copy = () => {
    void bestEffort(
      "copy draft",
      Clipboard.setStringAsync(body).then(() => setCopied({})),
    );
  };
  return [copied !== null, copy] as const;
}

function DraftHeading({ block }: { block: DraftBlock }) {
  const tokens = useMobileTokens();
  return (
    <View style={styles.headingRow}>
      <Text numberOfLines={1} style={[styles.heading, styles.label, { color: tokens.foreground }]}>
        {block.label}
      </Text>
      {block.to ? (
        <Text
          numberOfLines={1}
          style={[styles.heading, styles.to, { color: tokens.mutedForeground }]}
        >
          {block.to}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Something the bot wrote for the user to send: a short preview to copy, or open full screen to
 * mark the passages to change and have it revised. Notes belong to the version they were made on.
 */
export function DraftCard({
  block,
  messageId,
  target,
}: {
  block: DraftBlock;
  messageId: string;
  target: DraftTarget;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [marked, setMarked] = useState<{ version: number; notes: DraftNote[] }>({
    version: block.version,
    notes: [],
  });
  const notes = marked.version === block.version ? marked.notes : [];
  const [copied, copy] = useCopyDraft(block.body);
  return (
    <View
      testID="draft-card"
      style={[styles.card, { backgroundColor: tokens.card, borderColor: `${tokens.foreground}1F` }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t`Open ${block.label}`}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.preview, { opacity: pressed ? 0.7 : 1 }]}
      >
        <DraftHeading block={block} />
        {block.subject ? (
          <Text numberOfLines={1} style={[styles.subject, { color: tokens.foreground }]}>
            {block.subject}
          </Text>
        ) : null}
        <Text numberOfLines={4} style={[styles.previewBody, { color: tokens.foreground }]}>
          {block.body}
        </Text>
      </Pressable>
      <View style={[styles.footer, { borderTopColor: `${tokens.foreground}0A` }]}>
        <NativeActionButton
          label={copied ? t`Copied` : t`Copy`}
          prominence="plain"
          size="compact"
          onPress={copy}
        />
        <NativeActionButton
          label={t`Open`}
          prominence="secondary"
          size="compact"
          onPress={() => setOpen(true)}
        />
      </View>
      {open ? (
        <DraftSheet
          block={block}
          messageId={messageId}
          target={target}
          notes={notes}
          onNotesChange={(next) => setMarked({ version: block.version, notes: next })}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}

/**
 * The whole draft in a sheet: select a passage, say what should change, repeat, then Revise sends
 * every note at once as a reply to the draft. Tapping a marked passage shows its note.
 */
function DraftSheet({
  block,
  messageId,
  target,
  notes,
  onNotesChange,
  onClose,
}: {
  block: DraftBlock;
  messageId: string;
  target: DraftTarget;
  notes: readonly DraftNote[];
  onNotesChange: (notes: DraftNote[]) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const readOnly = useThreadReadOnly();
  const [copied, copy] = useCopyDraft(block.body);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [noteText, setNoteText] = useState("");
  // Typing a note moves focus off the draft, and the collapsed caret that leaves must not drop
  // the passage being noted.
  const [noting, setNoting] = useState(false);
  const [revision, setRevision] = useState(0);
  // A new version's text moves under any selected passage, so what was being noted is let go.
  const [version, setVersion] = useState(block.version);
  if (version !== block.version) {
    setVersion(block.version);
    setSelection(null);
    setNoteText("");
    setNoting(false);
  }
  const revise = useSave({
    save: (input: { text: string; clientNonce: string }, send) =>
      send("threads/send", {
        ...target,
        text: input.text,
        replyToMessageId: messageId,
        clientNonce: input.clientNonce,
      }),
    closesScreen: true,
    onSaved: () => {
      onNotesChange([]);
      onClose();
    },
  });

  const caret = selection !== null && selection.start === selection.end;
  const { shown, pending: pendingIndex } = draftNotesWithPending(
    block.body,
    notes,
    caret ? null : selection,
  );
  const pending = pendingIndex >= 0;
  const openNote = caret ? notes[draftNoteAt(notes, selection.start)] : undefined;

  const clearSelection = () => {
    setNoting(false);
    setSelection(null);
    setNoteText("");
  };
  const addNote = () => {
    if (!selection) return;
    const next = addDraftNote(block.body, notes, { ...selection, note: noteText });
    if (!next) return;
    onNotesChange(next);
    clearSelection();
    setRevision((value) => value + 1);
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View
        accessibilityViewIsModal
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          // Page sheets clear the notch on iOS; Android modals are full-screen.
          paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
          paddingBottom: insets.bottom,
        }}
      >
        <View style={styles.header}>
          <NativeActionButton label={t`Close`} onPress={onClose} prominence="plain" />
          <View style={styles.headerTitle}>
            <DraftHeading block={block} />
          </View>
          <NativeActionButton
            label={copied ? t`Copied` : t`Copy`}
            onPress={copy}
            prominence="plain"
          />
        </View>
        <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
          {block.subject ? (
            <Text style={[styles.sheetSubject, { color: tokens.foreground }]}>{block.subject}</Text>
          ) : null}
          <TextInput
            key={`${block.version}:${revision}`}
            testID="draft-body"
            multiline
            scrollEnabled={false}
            showSoftInputOnFocus={false}
            // Any edit (paste, hardware keyboard, dictation) remounts the field with the draft:
            // notes are offsets into the draft, so the text shown must never diverge from it.
            onChangeText={() => setRevision((value) => value + 1)}
            // Tapping the draft again is what puts a passage being noted down.
            onFocus={() => setNoting(false)}
            onSelectionChange={(event) => {
              const next = event.nativeEvent.selection;
              if (next.start === next.end) {
                if (!noting) setSelection(next);
                return;
              }
              setSelection(next);
              // Held from the selection itself, not from the note field's focus: the field takes
              // focus a moment later, and a caret the draft reports meanwhile must not drop it.
              setNoting(draftNotesWithPending(block.body, notes, next).pending >= 0);
            }}
            style={[styles.body, { color: tokens.foreground }]}
          >
            {draftSegments(block.body, shown).map((segment, index) => (
              <Text
                key={index}
                style={
                  segment.note === undefined
                    ? undefined
                    : {
                        backgroundColor: `${tokens.foreground}14`,
                        textDecorationLine: segment.note === pendingIndex ? "none" : "underline",
                      }
                }
              >
                {segment.text}
              </Text>
            ))}
          </TextInput>
        </ScrollView>
        <View style={[styles.bar, { borderTopColor: `${tokens.foreground}1F` }]}>
          {readOnly ? null : pending ? (
            <View style={styles.row}>
              <TextInput
                autoFocus
                accessibilityLabel={t`What should change?`}
                placeholder={t`What should change?`}
                placeholderTextColor={tokens.mutedForeground}
                value={noteText}
                onChangeText={setNoteText}
                onSubmitEditing={addNote}
                returnKeyType="done"
                style={[
                  styles.noteInput,
                  { color: tokens.foreground, backgroundColor: tokens.muted },
                ]}
              />
              <NativeActionButton
                label={t`Add`}
                disabled={!noteText.trim()}
                onPress={addNote}
                size="compact"
              />
            </View>
          ) : openNote ? (
            <View style={styles.row}>
              <Text style={[styles.noteText, { color: tokens.foreground }]}>{openNote.note}</Text>
              <NativeActionButton
                label={t`Remove`}
                prominence="destructive"
                size="compact"
                onPress={() => {
                  onNotesChange(notes.filter((note) => note !== openNote));
                  clearSelection();
                }}
              />
            </View>
          ) : (
            <View style={styles.row}>
              <Text
                style={[
                  styles.status,
                  { color: revise.error ? tokens.destructive : tokens.mutedForeground },
                ]}
              >
                {revise.error
                  ? errorText(revise.error, t`Could not send your notes`)
                  : notes.length
                    ? t`${plural(notes.length, { one: "# note", other: "# notes" })}`
                    : t`Select text to add a note`}
              </Text>
              <NativeActionButton
                label={t`Revise`}
                disabled={!notes.length}
                busy={revise.pending}
                size="compact"
                onPress={() =>
                  revise.run({
                    text: draftRevisionText(block.body, notes),
                    clientNonce: newClientId(),
                  })
                }
              />
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: { width: "100%", borderRadius: 24, borderWidth: 1, overflow: "hidden" },
  preview: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 12, gap: 6 },
  headingRow: { flexDirection: "row", alignItems: "baseline", gap: 8, minWidth: 0 },
  heading: { ...typeScale.caption },
  label: { flexShrink: 0, fontWeight: fontWeight.semibold },
  to: { flexShrink: 1 },
  subject: { ...typeScale.secondary, fontWeight: fontWeight.semibold },
  previewBody: { ...typeScale.secondary },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  headerTitle: { flex: 1, minWidth: 0, alignItems: "center" },
  scroll: { flex: 1, paddingHorizontal: 20 },
  sheetSubject: { ...typeScale.cardTitle, marginBottom: 12 },
  body: { ...typeScale.body, padding: 0, textAlignVertical: "top" },
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 20, paddingVertical: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  noteInput: { flex: 1, ...typeScale.body, borderRadius: 12, paddingHorizontal: 12, height: 40 },
  noteText: { flex: 1, ...typeScale.secondary },
  status: { flex: 1, ...typeScale.secondary },
});
