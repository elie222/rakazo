import { useLingui } from "@lingui/react/macro";
import type { MessageBlock, ToolQuestionDraft, ToolQuestionField } from "@rakazo/contracts";
import {
  toolQuestionInitialDraft,
  toolQuestionSentValues,
  toolQuestionShownStatus,
} from "@rakazo/contracts";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { native, useMobileTokens } from "../../lib/native/native";
import { useSave } from "../../lib/query/query";
import { useThreadReadOnly } from "../../lib/thread/thread-read-only";
import type { chatTargetInput } from "../../lib/thread/thread-target";
import { NativeActionButton } from "../native/native-action-button";
import { NativeSwitch } from "../native/native-switch";
import { MenuPicker } from "../ui/menu-picker";

type ToolQuestionBlock = Extract<MessageBlock, { kind: "tool_question" }>;

const styles = StyleSheet.create({
  card: { maxWidth: 576, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  field: { gap: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  input: {
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});

const KEYBOARDS = {
  email: "email-address",
  uri: "url",
  date: "default",
  "date-time": "default",
} as const;

function QuestionField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ToolQuestionField;
  value: ToolQuestionDraft[string];
  disabled: boolean;
  onChange: (value: ToolQuestionDraft[string]) => void;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const label = (
    <Text style={[typeScale.secondary, { color: tokens.foreground }]}>{field.label}</Text>
  );
  const description = field.description ? (
    <Text style={[typeScale.caption, { color: tokens.mutedForeground }]}>{field.description}</Text>
  ) : null;
  if (field.type === "boolean")
    return (
      <View style={styles.field}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>{label}</View>
          <NativeSwitch
            accessibilityLabel={field.label}
            value={value === true}
            disabled={disabled}
            onValueChange={onChange}
          />
        </View>
        {description}
      </View>
    );
  if (field.type === "choice")
    return (
      <View style={styles.field}>
        <MenuPicker
          label={field.label}
          plain
          // The native menu shows its first entry when nothing is chosen, so an optional choice
          // offers "None" first rather than looking picked.
          choices={[
            ...(field.required ? [] : [{ key: "", label: t`None` }]),
            ...field.options.map((option) => ({ key: option.value, label: option.label })),
          ]}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={onChange}
        />
        {description}
      </View>
    );
  return (
    <View style={styles.field}>
      {label}
      <TextInput
        accessibilityLabel={field.label}
        value={value === undefined ? "" : String(value)}
        editable={!disabled}
        autoCapitalize={field.type === "text" && !field.format ? "sentences" : "none"}
        keyboardType={
          field.type === "number"
            ? // The number pads have no minus key on iOS.
              field.minimum === undefined || field.minimum < 0
              ? "numbers-and-punctuation"
              : field.integer
                ? "number-pad"
                : "decimal-pad"
            : field.format
              ? KEYBOARDS[field.format]
              : "default"
        }
        maxLength={field.type === "text" ? field.maxLength : undefined}
        onChangeText={onChange}
        style={[styles.input, { borderColor: tokens.border, color: tokens.foreground }]}
      />
      {description}
    </View>
  );
}

/**
 * A question a tool's server asked while its call waits. Every word of it is the server's, shown
 * as plain text.
 */
export function ToolQuestionCard({
  block,
  messageId,
  target,
  canAnswer,
}: {
  block: ToolQuestionBlock;
  messageId: string;
  /** The conversation the question was asked in, a topic included. */
  target: ReturnType<typeof chatTargetInput>;
  canAnswer: boolean;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const readOnly = useThreadReadOnly();
  const { question } = block;
  const [values, setValues] = useState<ToolQuestionDraft>(() =>
    toolQuestionInitialDraft(question.fields),
  );
  const answer = useSave({
    save: (input: { action: "accept" | "decline"; values?: ToolQuestionDraft }, send) =>
      send("threads/answerToolQuestion", {
        ...target,
        messageId,
        action: input.action,
        ...(input.values ? { values: toolQuestionSentValues(question.fields, input.values) } : {}),
      }),
  });
  const sent = answer.input && !answer.pending && !answer.error ? answer.input.action : undefined;
  const status = toolQuestionShownStatus(block.status, sent);
  const open = status === "pending" && canAnswer && !readOnly;
  return (
    <View testID="tool-question-card" style={[styles.card, { backgroundColor: native.fill }]}>
      <Text style={[typeScale.caption, { color: tokens.mutedForeground }]}>{question.source}</Text>
      <Text style={[typeScale.body, { color: tokens.foreground }]}>{question.message}</Text>
      {open ? (
        <>
          {question.fields.map((field) => (
            <QuestionField
              key={field.name}
              field={field}
              value={values[field.name]}
              disabled={answer.pending}
              onChange={(value) => setValues((now) => ({ ...now, [field.name]: value }))}
            />
          ))}
          <View style={styles.actions}>
            <NativeActionButton
              label={t`Accept`}
              busy={answer.pending && answer.input?.action === "accept"}
              disabled={answer.pending}
              onPress={() => answer.run({ action: "accept", values })}
            />
            <NativeActionButton
              label={t`Decline`}
              prominence="secondary"
              disabled={answer.pending}
              onPress={() => answer.run({ action: "decline" })}
            />
          </View>
          {answer.error ? (
            <Text style={[typeScale.caption, { color: tokens.destructive }]}>
              {errorText(answer.error, t`Could not submit this answer`)}
            </Text>
          ) : null}
        </>
      ) : status === "pending" ? null : (
        <Text
          style={[
            typeScale.secondary,
            {
              color: status === "accepted" ? tokens.success : tokens.mutedForeground,
              fontWeight: fontWeight.medium,
            },
          ]}
        >
          {status === "accepted" ? t`Sent` : status === "declined" ? t`Declined` : t`Expired`}
        </Text>
      )}
    </View>
  );
}
