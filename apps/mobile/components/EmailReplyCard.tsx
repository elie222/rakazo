import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import type { EmailReplyEdit } from "@rakazo/core";
import {
  applyEmailReplyEdit,
  emailReplyCard,
  emailReplyDraftFromBlock,
  emailReplySaveFields,
} from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { useMobileTokens } from "../lib/native";
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
  const [draft, setDraft] = useState(() => emailReplyDraftFromBlock(block));
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const card = emailReplyCard(draft);

  useEffect(() => {
    if (block.status !== "ready") setDraft(emailReplyDraftFromBlock(block));
  }, [block]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  function persist(next: typeof draft) {
    return rpc("threads/emailReply", {
      ...target,
      messageId,
      draftId: next.id,
      action: { type: "save", ...emailReplySaveFields(next) },
    });
  }

  function change(edit: EmailReplyEdit) {
    let next: typeof draft;
    try {
      next = applyEmailReplyEdit(draft, edit);
    } catch (err) {
      setError(errorText(err));
      return;
    }
    setDraft(next);
    setError(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void persist(next).catch((err: unknown) => setError(errorText(err)));
    }, 400);
  }

  async function send() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      const saved = await rpc("threads/emailReply", {
        ...target,
        messageId,
        draftId: draft.id,
        action: { type: "send", ...emailReplySaveFields(draft) },
      });
      setDraft(emailReplyDraftFromBlock(saved));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function discard() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      const saved = await rpc("threads/emailReply", {
        ...target,
        messageId,
        draftId: draft.id,
        action: { type: "discard" },
      });
      setDraft(emailReplyDraftFromBlock(saved));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const rows: Array<[string, string, ((value: string) => void) | undefined]> = [
    [t`From`, card.from, undefined],
    [t`In reply to`, draft.inReplyTo, (value) => change({ inReplyTo: value })],
    [t`To`, draft.toText, (value) => change({ to: value })],
    [t`Cc`, draft.ccText, (value) => change({ cc: value })],
    [t`Subject`, draft.subject, (value) => change({ subject: value })],
  ];

  return (
    <View style={[styles.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={styles.header}>
        <Text style={{ color: tokens.foreground, ...typeScale.body }}>{t`Mail`}</Text>
        <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>
          {card.statusLabel}
        </Text>
      </View>
      {rows.map(([label, value, onChange]) => (
        <View key={label} style={[styles.row, { borderColor: tokens.border }]}>
          <Text style={[styles.label, { color: tokens.mutedForeground, ...typeScale.caption }]}>
            {label}
          </Text>
          <TextInput
            accessibilityLabel={label}
            editable={card.editable && Boolean(onChange)}
            value={value}
            onChangeText={onChange}
            style={[styles.input, { color: tokens.foreground, ...typeScale.body }]}
          />
        </View>
      ))}
      <TextInput
        accessibilityLabel={t`Message`}
        editable={card.editable}
        multiline
        value={draft.body}
        onChangeText={(body) => change({ body })}
        style={[styles.body, { color: tokens.foreground, ...typeScale.body }]}
      />
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={!card.editable}
          onPress={() => void send()}
          style={[styles.button, { backgroundColor: tokens.foreground }]}
        >
          <Text style={{ color: tokens.background }}>{t`Send`}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!card.editable}
          onPress={() => void discard()}
          style={[
            styles.button,
            { borderColor: tokens.border, borderWidth: StyleSheet.hairlineWidth },
          ]}
        >
          <Text style={{ color: tokens.foreground }}>{t`Discard`}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t`Approval`}
          disabled={!card.editable}
          onPress={() =>
            change({
              approval: draft.approval === "needs_approval" ? "send_once" : "needs_approval",
            })
          }
          style={[
            styles.button,
            { borderColor: tokens.border, borderWidth: StyleSheet.hairlineWidth },
          ]}
        >
          <Text style={{ color: tokens.foreground }}>
            {draft.approval === "needs_approval" ? t`Needs approval` : t`Send once`}
          </Text>
        </Pressable>
      </View>
      {error ? <Text style={{ color: tokens.destructive, padding: 12 }}>{error}</Text> : null}
    </View>
  );
}
