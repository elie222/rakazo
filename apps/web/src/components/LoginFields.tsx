import { Trans, useLingui } from "@lingui/react/macro";
import type { LoginFieldInput } from "@rakazo/contracts";
import { LOGIN_FIELD_LIMIT } from "@rakazo/contracts";
import { Button, Input, Label, Switch } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useId } from "react";

/** One login value: hidden ones stay masked and are typed only into password fields. */
export function LoginFieldValue({
  label,
  field,
  disabled,
  onChange,
}: {
  label: string;
  field: Pick<LoginFieldInput, "value" | "hidden">;
  disabled?: boolean;
  onChange: (change: Partial<LoginFieldInput>) => void;
}) {
  const switchId = useId();
  return (
    <div data-testid="login-field-value" className="flex items-center gap-3">
      <Input
        className="w-full"
        aria-label={label}
        placeholder={label}
        type={field.hidden ? "password" : "text"}
        // "off" is ignored for username-like fields; this stops browsers saving the login.
        autoComplete="new-password"
        spellCheck={false}
        disabled={disabled}
        value={field.value}
        onChange={(event) => onChange({ value: event.target.value })}
      />
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          id={switchId}
          // Every switch is named "Hidden"; the field it belongs to tells them apart.
          aria-describedby={`${switchId}-field`}
          size="sm"
          checked={field.hidden}
          disabled={disabled}
          onCheckedChange={(hidden) => onChange({ hidden })}
        />
        <Label htmlFor={switchId} className="text-[13px] font-normal text-muted-foreground">
          <Trans>Hidden</Trans>
        </Label>
        <span id={`${switchId}-field`} className="sr-only">
          {label}
        </span>
      </div>
    </div>
  );
}

/** The fields of a website login being added or replaced in settings, each with its own label. */
export function LoginFieldsEditor({
  fields,
  disabled,
  onChange,
}: {
  fields: LoginFieldInput[];
  disabled?: boolean;
  onChange: (fields: LoginFieldInput[]) => void;
}) {
  const { t } = useLingui();
  const update = (index: number, change: Partial<LoginFieldInput>) =>
    onChange(fields.map((field, at) => (at === index ? { ...field, ...change } : field)));
  return (
    <div className="mt-3 flex flex-col gap-3" data-testid="login-fields">
      {fields.map((field, index) => (
        <div key={index} className="flex flex-col gap-1.5" data-testid="login-field">
          <div className="flex items-center gap-2">
            <Input
              aria-label={t`Label`}
              placeholder={t`Label`}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              value={field.label}
              onChange={(event) => update(index, { label: event.target.value })}
            />
            {fields.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t`Remove`}
                disabled={disabled}
                onClick={() => onChange(fields.filter((_, at) => at !== index))}
              >
                <X />
              </Button>
            ) : null}
          </div>
          <LoginFieldValue
            label={field.label.trim() || t`Value`}
            field={field}
            disabled={disabled}
            onChange={(change) => update(index, change)}
          />
        </div>
      ))}
      {fields.length < LOGIN_FIELD_LIMIT ? (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={disabled}
          onClick={() => onChange([...fields, { label: "", value: "", hidden: true }])}
        >
          <Trans>Add field</Trans>
        </Button>
      ) : null}
    </div>
  );
}
