import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { useEmailReplyDraft } from "@rakazo/chat-ui/hooks";
import type { MessageBlock } from "@rakazo/contracts";
import type { EmailReplyCommitAction } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useRef } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useMobileTokens } from "../lib/native";
import type { SaveSend } from "../lib/query";
import { useSave } from "../lib/query";
import { errorText } from "../lib/user-error";

type EmailReplyBlock = Extract<MessageBlock, { kind: "email_reply" }>;
type ThreadTarget = { botId: string } | { groupId: string };

const styles = StyleSheet.create({
  card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  row: {
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
  },
  label: { width: 88 },
  input: { flex: 1, paddingVertical: 10 },
  body: { minHeight: 120, paddingHorizontal: 16, paddingVertical: 12, textAlignVertical: "top" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12 },
  button: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 },
});

/** Mobile review card. Edits write back to the same saved draft as on the web. */
export function EmailReplyCard({
  block,
  messageId,
  target,
}: {
  block: EmailReplyBlock;
  messageId: string;
  target: ThreadTarget;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const session = useRef<ReturnType<typeof useEmailReplyDraft> | null>(null);
  const reply = (input: EmailReplyCommitAction, send: SaveSend) =>
    send("threads/emailReply", { ...target, messageId, draftId: block.draftId, action: input });
  const autosave = useSave({ save: reply });
  const commit = useSave({
    save: reply,
    onSaved: (saved) => {
      if (saved.status !== "ready") session.current?.replace(saved);
    },
  });
  const draft = useEmailReplyDraft({
    block,
    pending: autosave.pending || commit.pending,
    run: (action) => (action.type === "save" ? autosave.run(action) : commit.run(action)),
    onEdit: () => {
      autosave.reset();
      commit.reset();
    },
  });
  session.current = draft;
  const { card } = draft;
  const locked = !card.editable || autosave.pending || commit.pending;
  const failure = commit.error ?? autosave.error;
  const error = failure ? errorText(failure) : null;
  const rows: Array<{ label: string; value: string; onChange?: (value: string) => void }> = [
    { label: t`From`, value: card.from },
  ];
  if (card.showInReplyTo) {
    rows.push({
      label: t`In reply to`,
      value: draft.draft.inReplyTo,
      onChange: (value) => draft.change({ inReplyTo: value }),
    });
  }
  rows.push(
    { label: t`To`, value: draft.draft.toText, onChange: (value) => draft.change({ to: value }) },
    { label: t`Cc`, value: draft.draft.ccText, onChange: (value) => draft.change({ cc: value }) },
    {
      label: t`Subject`,
      value: draft.draft.subject,
      onChange: (value) => draft.change({ subject: value }),
    },
  );

  return (
    <View style={[styles.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={styles.header}>
        <Text style={{ color: tokens.foreground, ...typeScale.body }}>{t`Mail`}</Text>
        <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>
          {card.statusLabel}
        </Text>
      </View>
      {rows.map(({ label, value, onChange }) => (
        <View key={label} style={[styles.row, { borderColor: tokens.border }]}>
          <Text style={[styles.label, { color: tokens.mutedForeground, ...typeScale.caption }]}>
            {label}
          </Text>
          <TextInput
            accessibilityLabel={label}
            editable={!locked && Boolean(onChange)}
            value={value}
            onChangeText={onChange}
            style={[styles.input, { color: tokens.foreground, ...typeScale.body }]}
          />
        </View>
      ))}
      <TextInput
        accessibilityLabel={t`Message`}
        editable={!locked}
        multiline
        value={draft.draft.body}
        onChangeText={(body) => draft.change({ body })}
        style={[styles.body, { color: tokens.foreground, ...typeScale.body }]}
      />
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={locked}
          onPress={() => draft.send()}
          style={[styles.button, { backgroundColor: tokens.foreground }]}
        >
          <Text style={{ color: tokens.background }}>{t`Send`}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={locked}
          onPress={() => draft.discard()}
          style={[
            styles.button,
            { borderColor: tokens.border, borderWidth: StyleSheet.hairlineWidth },
          ]}
        >
          <Text style={{ color: tokens.foreground }}>{t`Discard`}</Text>
        </Pressable>
        <MenuView
          actions={[
            { id: "needs_approval", title: t`Needs approval` },
            { id: "send_once", title: t`Send once` },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (locked) return;
            const approval = nativeEvent.event === "send_once" ? "send_once" : "needs_approval";
            draft.change({ approval });
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t`Approval`}
            disabled={locked}
            style={[
              styles.button,
              { borderColor: tokens.border, borderWidth: StyleSheet.hairlineWidth },
            ]}
          >
            <Text style={{ color: tokens.foreground }}>
              {draft.draft.approval === "needs_approval" ? t`Needs approval` : t`Send once`}
            </Text>
          </Pressable>
        </MenuView>
      </View>
      {error ? <Text style={{ color: tokens.destructive, padding: 12 }}>{error}</Text> : null}
    </View>
  );
}
