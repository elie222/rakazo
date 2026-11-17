import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import {
  EmailReplyDraftError,
  EmailReplyDraftStore,
  type EmailReplyEdit,
  emailReplyDraftFromBlock,
} from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useMobileTokens } from "../lib/native";

type EmailReplyBlock = Extract<MessageBlock, { kind: "email_reply" }>;

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
  actions: { flexDirection: "row", gap: 8, padding: 12 },
  button: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 },
});

/** Mobile review card. Edits write back to the same saved draft as on the web. */
export function EmailReplyCard({ block }: { block: EmailReplyBlock }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [session] = useState(() => {
    const store = new EmailReplyDraftStore();
    return { store, card: store.save(emailReplyDraftFromBlock(block)) };
  });
  const [card, setCard] = useState(session.card);
  const [error, setError] = useState<string | null>(null);

  function change(edit: EmailReplyEdit) {
    try {
      setCard(session.store.edit(card.draftId, edit));
      setError(null);
    } catch (err) {
      setError(err instanceof EmailReplyDraftError ? err.message : t`Could not save this draft`);
    }
  }

  return (
    <View style={[styles.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={styles.header}>
        <Text style={{ color: tokens.foreground, ...typeScale.body }}>{t`Reply`}</Text>
        <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>{card.statusLabel}</Text>
      </View>
      {(
        [
          [t`From`, card.from, undefined],
          [t`In reply to`, card.inReplyTo, (value: string) => change({ inReplyTo: value })],
          [t`To`, card.to, (value: string) => change({ to: value })],
          [t`Cc`, card.cc, (value: string) => change({ cc: value })],
          [t`Subject`, card.subject, (value: string) => change({ subject: value })],
        ] as const
      ).map(([label, value, onChange]) => (
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
        value={card.body}
        onChangeText={(body) => change({ body })}
        style={[styles.body, { color: tokens.foreground, ...typeScale.body }]}
      />
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={!card.editable}
          onPress={() => {
            try {
              session.store.send(card.draftId);
              setCard(session.store.open(card.draftId));
            } catch (err) {
              setError(err instanceof EmailReplyDraftError ? err.message : t`Could not send`);
            }
          }}
          style={[styles.button, { backgroundColor: tokens.foreground }]}
        >
          <Text style={{ color: tokens.background }}>{t`Send`}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!card.editable}
          onPress={() => {
            try {
              session.store.discard(card.draftId);
              setCard(session.store.open(card.draftId));
            } catch (err) {
              setError(err instanceof EmailReplyDraftError ? err.message : t`Could not discard`);
            }
          }}
          style={[styles.button, { borderColor: tokens.border, borderWidth: StyleSheet.hairlineWidth }]}
        >
          <Text style={{ color: tokens.foreground }}>{t`Discard`}</Text>
        </Pressable>
      </View>
      {error ? <Text style={{ color: tokens.destructive, padding: 12 }}>{error}</Text> : null}
    </View>
  );
}
