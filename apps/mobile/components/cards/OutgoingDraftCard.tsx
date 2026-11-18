import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import {
  OutgoingDraftValues,
  outgoingDraftAnswer,
  outgoingDraftPresentation,
} from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import type { MobileArtifactTarget } from "../../lib/artifacts/artifact-open";
import { native, useMobileTokens } from "../../lib/native/native";
import { useSave } from "../../lib/query/query";
import { useThreadReadOnly } from "../../lib/thread/thread-read-only";
import { NativeActionButton } from "../native/native-action-button";
import { NativeSymbol } from "../native/native-symbol";

export function OutgoingDraftCard({
  block,
  messageId,
  runId,
  target,
  canAnswer,
}: {
  block: Extract<MessageBlock, { kind: "ask" }>;
  messageId: string;
  runId?: string | null;
  target: MobileArtifactTarget;
  canAnswer: boolean;
}) {
  const draft = block.outgoingDraft!;
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const readOnly = useThreadReadOnly();
  const [values, setValues] = useState(draft.values);
  const answer = useSave({
    save: (input: { runId: string; answer: string }, send) =>
      send("threads/answer", { ...target, messageId, ...input }),
  });
  const { status, shown, isEmail } = outgoingDraftPresentation(
    block,
    draft.values,
    values,
    canAnswer && Boolean(runId) && !readOnly,
    !answer.pending && !answer.error ? answer.input?.answer : undefined,
  );
  const open = status === "pending";
  const toLabel = t`To`;
  const caption = [typeScale.caption, { color: tokens.mutedForeground }];
  const body = [typeScale.body, { color: tokens.foreground }];
  const subjectStyle = [typeScale.headline, { color: tokens.foreground }];
  const editable = Boolean(open && !answer.pending);

  return (
    <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <View style={styles.content}>
        <View style={styles.header}>
          <NativeSymbol
            ios={isEmail ? "envelope" : "bubble.left"}
            android={isEmail ? "mail-outline" : "chatbubble-outline"}
            size={16}
            color={tokens.mutedForeground}
          />
          <Text style={caption}>{t`${draft.source} draft`}</Text>
        </View>
        {open && block.detail ? (
          <Text
            style={[styles.warning, { borderStartColor: tokens.warning, color: tokens.foreground }]}
          >
            {block.detail}
          </Text>
        ) : null}
        {shown.kind === "email" ? (
          open && values.kind === "email" ? (
            <TextInput
              accessibilityLabel={t`Subject`}
              placeholder={t`Subject`}
              placeholderTextColor={tokens.mutedForeground}
              value={values.subject}
              onChangeText={(subject) => setValues({ ...values, subject })}
              style={[styles.input, ...subjectStyle]}
              editable={editable}
            />
          ) : shown.subject ? (
            <Text style={subjectStyle}>{shown.subject}</Text>
          ) : null
        ) : null}
        <View style={[styles.recipient, { borderBottomColor: tokens.border }]}>
          <Text style={caption}>{toLabel}</Text>
          {open ? (
            <TextInput
              accessibilityLabel={toLabel}
              keyboardType={isEmail ? "email-address" : "default"}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              value={values.to}
              onChangeText={(to) => setValues({ ...values, to })}
              style={[styles.input, styles.recipientValue, ...body]}
              editable={editable}
            />
          ) : (
            <Text style={[styles.recipientValue, ...body]}>{shown.to}</Text>
          )}
        </View>
        {open ? (
          <TextInput
            accessibilityLabel={t`Message`}
            placeholder={t`Message`}
            placeholderTextColor={tokens.mutedForeground}
            value={values.body}
            onChangeText={(body) => setValues({ ...values, body })}
            style={[styles.input, styles.message, ...body]}
            editable={editable}
            multiline
          />
        ) : (
          <Text style={body}>{shown.body}</Text>
        )}
      </View>
      <View
        style={[styles.footer, { backgroundColor: native.fill, borderTopColor: tokens.border }]}
      >
        {open && runId ? (
          <>
            <NativeActionButton
              label={t`Discard`}
              prominence="quiet"
              disabled={answer.pending}
              onPress={() => answer.run({ runId, answer: "deny" })}
            />
            <NativeActionButton
              label={t`Send`}
              busy={answer.pending && answer.input?.answer !== "deny"}
              disabled={answer.pending || !OutgoingDraftValues.safeParse(values).success}
              onPress={() => answer.run({ runId, answer: outgoingDraftAnswer(values) })}
            />
          </>
        ) : (
          <Text style={caption}>
            {status === "expired"
              ? t`Expired`
              : status === "discarded"
                ? t`Discarded`
                : status === "approved"
                  ? t`Approved`
                  : t`No longer active`}
          </Text>
        )}
      </View>
      {answer.error ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: tokens.destructive }]}>
          {errorText(answer.error, t`Couldn’t submit the draft`)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    maxWidth: 576,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  warning: { ...typeScale.secondary, borderStartWidth: 2, paddingStart: 10 },
  input: { padding: 0 },
  recipient: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  recipientValue: { flex: 1 },
  message: { minHeight: 72, textAlignVertical: "top" },
  footer: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  error: { paddingHorizontal: 16, paddingBottom: 12 },
});
