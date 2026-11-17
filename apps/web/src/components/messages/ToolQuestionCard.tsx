import { Trans, useLingui } from "@lingui/react/macro";
import type { ThreadMessage, ToolQuestionField, ToolQuestionValue } from "@rakazo/contracts";
import { toolQuestionInitialValues, toolQuestionSentValues } from "@rakazo/contracts";
import {
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  OptionSelect,
} from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { useId, useState } from "react";
import type { ArtifactTarget } from "../../lib/pages/artifact-open";
import { useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { BuiCard } from "../ai/primitives";

type ToolQuestionBlock = Extract<ThreadMessage["blocks"][number], { kind: "tool_question" }>;
type Values = Record<string, ToolQuestionValue | undefined>;

const INPUT_TYPES = { email: "email", uri: "url", date: "date", "date-time": "datetime-local" };

function QuestionField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ToolQuestionField;
  value: ToolQuestionValue | undefined;
  disabled: boolean;
  onChange: (value: ToolQuestionValue | undefined) => void;
}) {
  const id = useId();
  const description = field.description ? (
    <FieldDescription>{field.description}</FieldDescription>
  ) : null;
  if (field.type === "boolean")
    return (
      <Field orientation="horizontal" className="items-start gap-3">
        <Checkbox
          id={id}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <div className="flex flex-col gap-0.5">
          <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
          {description}
        </div>
      </Field>
    );
  return (
    <Field>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      {field.type === "choice" ? (
        <OptionSelect
          id={id}
          value={typeof value === "string" ? value : null}
          options={field.options}
          disabled={disabled}
          required={field.required}
          onValueChange={onChange}
        />
      ) : (
        <Input
          id={id}
          type={
            field.type === "number" ? "number" : field.format ? INPUT_TYPES[field.format] : "text"
          }
          required={field.required}
          disabled={disabled}
          value={value === undefined ? "" : String(value)}
          {...(field.type === "number"
            ? { min: field.minimum, max: field.maximum, step: field.integer ? 1 : "any" }
            : { minLength: field.minLength, maxLength: field.maxLength })}
          onChange={(event) => {
            const text = event.target.value;
            if (field.type !== "number") return onChange(text === "" ? undefined : text);
            onChange(text === "" || Number.isNaN(Number(text)) ? undefined : Number(text));
          }}
        />
      )}
      {description}
    </Field>
  );
}

/**
 * A question a tool's server asked while its call waits. Every word of it is the server's: it is
 * shown as plain text, never as markdown or links.
 */
export function ToolQuestionCard({
  block,
  messageId,
  target,
  canAnswer,
}: {
  block: ToolQuestionBlock;
  messageId: string;
  target: ArtifactTarget;
  canAnswer: boolean;
}) {
  const { t } = useLingui();
  const { question } = block;
  const [values, setValues] = useState<Values>(() => toolQuestionInitialValues(question.fields));
  const answer = useSave({
    save: (input: { action: "accept" | "decline"; values?: Values }, rpc) =>
      rpc.threads.answerToolQuestion({
        ...target,
        messageId,
        action: input.action,
        ...(input.values ? { values: toolQuestionSentValues(input.values) } : {}),
      }),
  });
  const sent = answer.input && !answer.pending && !answer.error ? answer.input.action : undefined;
  const status =
    block.status === "pending" && sent
      ? sent === "accept"
        ? "accepted"
        : "declined"
      : block.status;
  const open = status === "pending" && canAnswer;
  return (
    <BuiCard data-testid="tool-question-card" className="w-full min-w-0 max-w-xl px-5 py-4">
      <div className="text-body-sm text-muted-foreground">{question.source}</div>
      <p className="mt-1 whitespace-pre-wrap break-words text-body-lg leading-[1.5] text-foreground">
        {question.message}
      </p>
      {open ? (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            answer.run({ action: "accept", values });
          }}
        >
          {question.fields.map((field) => (
            <QuestionField
              key={field.name}
              field={field}
              value={values[field.name]}
              disabled={answer.pending}
              onChange={(value) => setValues((now) => ({ ...now, [field.name]: value }))}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={answer.pending}>
              <Trans>Accept</Trans>
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={answer.pending}
              onClick={() => answer.run({ action: "decline" })}
            >
              <Trans>Decline</Trans>
            </Button>
          </div>
          {answer.error ? (
            <p className="text-body-sm text-destructive">
              {errorText(answer.error, t`Could not submit this answer`)}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="mt-3.5 flex items-center gap-1.5 text-body font-medium text-muted-foreground">
          {status === "accepted" ? <Check aria-hidden className="size-4" /> : null}
          {status === "accepted"
            ? t`Sent`
            : status === "declined"
              ? t`Declined`
              : status === "expired"
                ? t`Expired`
                : t`No longer active`}
        </div>
      )}
    </BuiCard>
  );
}
