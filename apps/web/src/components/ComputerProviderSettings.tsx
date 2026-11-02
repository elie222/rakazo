import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerProviderSettings as Settings } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";

type Draft = { provider: string; values: Record<string, string> };

// The RPC client hands out a new object on every property read, so pick by scope, never hold it.
function settingsApi(scope: "deployment" | "account") {
  return scope === "account" ? rpc.computerProvider.account : rpc.computerProvider;
}

function draftFrom(settings: Settings): Draft {
  return { provider: settings.provider, values: settings.values };
}

export function ComputerProviderSettings({
  scope,
  onProviderChange,
}: {
  scope: "deployment" | "account";
  onProviderChange?: (sandboxProvider: string) => void;
}) {
  const { t } = useLingui();
  const selectId = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    settingsApi(scope)
      .get()
      .then((next) => {
        if (!alive) return;
        setSettings(next);
        setDraft(draftFrom(next));
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught, t`Could not load computer settings`));
      });
    return () => {
      alive = false;
    };
  }, [scope, t]);

  if (!draft || !settings) {
    return error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null;
  }

  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...draft, ...patch });
  };
  async function save() {
    if (!draft || pending) return;
    setPending(true);
    setError(null);
    try {
      const next = await settingsApi(scope).update(draft);
      setSettings(next);
      setDraft(draftFrom(next));
      setSaved(true);
      onProviderChange?.(next.provider === "default" ? next.defaultProvider : next.provider);
    } catch (caught) {
      setError(errorText(caught, t`Could not save computer settings`));
    } finally {
      setPending(false);
    }
  }

  const descriptor = settings.providers.find((provider) => provider.id === draft.provider);
  if (settings.providers.length === 0) return null;
  return (
    <>
      <form
        className="mt-4 grid gap-3"
        data-testid="computer-provider-settings"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field>
          <FieldLabel htmlFor={selectId}>
            <Trans>New computers run on</Trans>
          </FieldLabel>
          <NativeSelect
            id={selectId}
            value={draft.provider}
            onChange={(event) =>
              set({
                provider: event.target.value,
                values: event.target.value === settings.provider ? settings.values : {},
              })
            }
            className="w-full"
          >
            <NativeSelectOption value="default">
              {t`Deployment default (${settings.defaultProvider})`}
            </NativeSelectOption>
            {settings.providers.map((provider) => (
              <NativeSelectOption key={provider.id} value={provider.id}>
                {provider.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        {descriptor?.fields.map((field) => {
          const saved =
            draft.provider === settings.provider &&
            settings.savedSecrets[field.key] &&
            !descriptor.fields.some(
              (candidate) =>
                candidate.kind === "url" &&
                draft.values[candidate.key] !== settings.values[candidate.key],
            );
          const change = (value: string) =>
            set({ values: { ...draft.values, [field.key]: value } });
          return field.kind === "select" ? (
            <Field key={field.key}>
              <FieldLabel htmlFor={`${selectId}-${field.key}`}>{field.label}</FieldLabel>
              <NativeSelect
                id={`${selectId}-${field.key}`}
                value={draft.values[field.key] ?? ""}
                onChange={(event) => change(event.target.value)}
                required={field.required}
              >
                <NativeSelectOption value="" />
                {field.options?.map((option) => (
                  <NativeSelectOption key={option.value} value={option.value}>
                    {option.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ) : (
            <TextField
              key={field.key}
              label={field.label}
              value={draft.values[field.key] ?? ""}
              onChange={change}
              required={field.required && !saved}
              secret={field.kind === "secret"}
              type={field.kind === "url" ? "url" : "text"}
              placeholder={saved ? t`Saved` : undefined}
            />
          );
        })}
        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={pending}>
            <Trans>Save</Trans>
          </Button>
          {saved ? <SuccessPop label={t`Saved`} /> : null}
        </div>
      </form>
      {scope === "deployment" &&
      settings.providers.some((provider) => provider.capabilities.perAccount) ? (
        <Collapsible className="mt-4">
          <CollapsibleTrigger className="text-[13px] text-muted-foreground">
            <Trans>My computers</Trans>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ComputerProviderSettings scope="account" onProviderChange={onProviderChange} />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  required,
  secret,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  type?: "text" | "url";
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={secret ? "password" : type}
        autoComplete={secret ? "off" : undefined}
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
