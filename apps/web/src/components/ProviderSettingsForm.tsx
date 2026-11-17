import { Trans, useLingui } from "@lingui/react/macro";
import type { ProviderSettingsField } from "@rakazo/contracts";
import type { SettingsFieldProblem } from "@rakazo/core";
import {
  initialSettingsValues,
  keepsSavedSecrets,
  settingsFieldProblem,
  settingsFormReady,
  settingsSubmission,
  visibleSettingsFields,
} from "@rakazo/core";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Label,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";

export interface ProviderSettingsDraft {
  settings: Record<string, string>;
  credentials: Record<string, string>;
}

// Field text comes from the server in English; translate what the providers use.
function useFieldText() {
  const { t } = useLingui();
  const known: Record<string, string> = {
    "Allow writing": t`Allow writing`,
    "API key": t`API key`,
    "Base URL": t`Base URL`,
    "Bearer token": t`Bearer token`,
    "Brain label": t`Brain label`,
    Cloud: t`Cloud`,
    Connection: t`Connection`,
    High: t`High`,
    "Instance API key": t`Instance API key`,
    "Learn from conversations": t`Learn from conversations`,
    Low: t`Low`,
    "MCP endpoint": t`MCP endpoint`,
    Medium: t`Medium`,
    "Organization API key": t`Organization API key`,
    "rakazo-shared and IDs starting with bot- are reserved for Rakazo.": t`rakazo-shared and IDs starting with bot- are reserved for Rakazo.`,
    "Recall and write": t`Recall and write`,
    "Recall automatically": t`Recall automatically`,
    "Recall depth": t`Recall depth`,
    "Recall from banks": t`Recall from banks`,
    "Recall from this peer; save to Rakazo’s own peers.": t`Recall from this peer; save to Rakazo’s own peers.`,
    "Recall only": t`Recall only`,
    "Self-hosted": t`Self-hosted`,
    "Skip unrelated memories": t`Skip unrelated memories`,
    Summaries: t`Summaries`,
    "Summaries and facts": t`Summaries and facts`,
    "Use up to 512 letters, digits, _ or -.": t`Use up to 512 letters, digits, _ or -.`,
    "User peer": t`User peer`,
    "What to recall": t`What to recall`,
    Workspace: t`Workspace`,
  };
  return (text: string) => known[text] ?? text;
}

function Segmented({
  label,
  options,
  value,
  busy,
  onChange,
}: {
  label: string;
  options: readonly { value: string; label: string }[];
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const labelId = useId();
  return (
    <Field className="mt-4" aria-labelledby={labelId}>
      <FieldLabel id={labelId}>{label}</FieldLabel>
      <ToggleGroup
        aria-labelledby={labelId}
        value={[value]}
        disabled={busy}
        spacing={1}
        onValueChange={([next]) => {
          const selected = options.find((option) => option.value === next);
          if (selected) onChange(selected.value);
        }}
        className="grid w-full gap-1 rounded-lg bg-muted p-1"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}

function SwitchRow({
  label,
  checked,
  busy,
  onChange,
}: {
  label: string;
  checked: boolean;
  busy: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="mt-4 flex items-center gap-2">
      <Switch id={id} size="sm" checked={checked} disabled={busy} onCheckedChange={onChange} />
      <Label htmlFor={id} className="text-body-sm font-normal">
        {label}
      </Label>
    </div>
  );
}

function TextField({
  field,
  value,
  busy,
  error,
  savedSecret,
  onChange,
}: {
  field: ProviderSettingsField;
  value: string;
  busy: boolean;
  error: string | undefined;
  /** The saved secret is used while the field stays empty. */
  savedSecret: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useLingui();
  const text = useFieldText();
  const id = useId();
  const errorId = useId();
  const descriptionId = useId();
  const secret = field.kind === "secret";
  const describedBy = [field.description ? descriptionId : null, error ? errorId : null]
    .filter(Boolean)
    .join(" ");
  return (
    <Field className="mt-4" data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{text(field.label)}</FieldLabel>
      <Input
        id={id}
        value={value}
        disabled={busy}
        required={field.required && !secret ? true : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(event) => onChange(event.target.value)}
        placeholder={savedSecret ? t`Saved` : field.placeholder}
        type={secret ? "password" : undefined}
        autoComplete={secret ? "new-password" : "off"}
        maxLength={field.maxLength}
      />
      {field.description ? (
        <p id={descriptionId} className="mt-2 text-body-sm text-muted-foreground">
          {text(field.description)}
        </p>
      ) : null}
      {error ? <FieldError id={errorId}>{text(error)}</FieldError> : null}
    </Field>
  );
}

/**
 * A provider's settings form, drawn from the fields the server describes. `saved` holds the
 * connected provider's settings when editing it. Secrets are never sent back to the client, so a
 * secret left empty while editing keeps the stored one.
 */
export function ProviderSettingsForm({
  fields,
  saved,
  busy,
  advancedSettings,
  onSubmit,
}: {
  fields: readonly ProviderSettingsField[];
  saved?: Record<string, string>;
  busy: boolean;
  /** Shown first in the advanced section, ahead of the provider's own advanced fields. */
  advancedSettings: ReactNode;
  onSubmit: (draft: ProviderSettingsDraft) => void;
}) {
  const text = useFieldText();
  const editing = saved !== undefined;
  const [values, setValues] = useState(() => initialSettingsValues(fields, saved));
  // Required fields with their own message say so on submit instead of holding the button.
  const [missing, setMissing] = useState<readonly string[]>([]);
  const visible = visibleSettingsFields(fields, values);
  // Editing keeps the stored secrets only while nothing they can reach has changed.
  const keepsSecrets = keepsSavedSecrets(fields, values, saved);
  const problems = new Map<ProviderSettingsField, SettingsFieldProblem | null>(
    visible.map((field) => [field, settingsFieldProblem(field, values, keepsSecrets)]),
  );
  const ready = settingsFormReady(fields, values, saved);

  function change(field: ProviderSettingsField, value: string) {
    setValues((now) => ({ ...now, [field.key]: value }));
    setMissing((now) => now.filter((key) => key !== field.key));
  }

  function submit() {
    if (!ready) return;
    const unfilled = visible
      .filter((field) => problems.get(field)?.rule === "required")
      .map((field) => field.key);
    setMissing(unfilled);
    if (unfilled.length === 0) onSubmit(settingsSubmission(fields, values));
  }

  function control(field: ProviderSettingsField) {
    const value = values[field.key] ?? "";
    if (field.kind === "toggle") {
      return (
        <SwitchRow
          key={field.key}
          label={text(field.label)}
          checked={value === "true"}
          busy={busy}
          onChange={(checked) => change(field, String(checked))}
        />
      );
    }
    if (field.kind === "select") {
      return (
        <Segmented
          key={field.key}
          label={text(field.label)}
          busy={busy}
          value={value}
          onChange={(next) => change(field, next)}
          options={(field.options ?? []).map((option) => ({
            value: option.value,
            label: text(option.label),
          }))}
        />
      );
    }
    const problem = problems.get(field);
    const error =
      problem?.rule === "check" || (problem?.rule === "required" && missing.includes(field.key))
        ? problem.message
        : undefined;
    return (
      <TextField
        key={field.key}
        field={field}
        value={value}
        busy={busy}
        error={error}
        // An optional secret may never have been saved, so only a required one says it is.
        savedSecret={field.kind === "secret" && field.required && keepsSecrets}
        onChange={(next) => change(field, next)}
      />
    );
  }

  const advanced = visible.filter((field) => field.advanced);
  return (
    <>
      {visible.filter((field) => !field.advanced).map(control)}

      {advancedSettings || fields.some((field) => field.advanced) ? (
        <Collapsible className="mt-4">
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
            <Trans>Advanced</Trans>
            <ChevronDownIcon className="size-4" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            {advancedSettings}
            {advanced.map(control)}
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      <Button
        type="button"
        variant="secondary"
        className="mt-5"
        disabled={busy || !ready}
        onClick={submit}
      >
        {editing ? (
          busy ? (
            <Trans>Saving…</Trans>
          ) : (
            <Trans>Save</Trans>
          )
        ) : busy ? (
          <Trans>Connecting…</Trans>
        ) : (
          <Trans>Connect</Trans>
        )}
      </Button>
    </>
  );
}
