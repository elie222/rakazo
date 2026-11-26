import { useLingui } from "@lingui/react/macro";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  OptionSelect,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import type { ConnectableProvider } from "./role-model-picker";

type Change =
  | { kind: "select"; id: string | null }
  | { kind: "remove"; id: string }
  | {
      kind: "create";
      provider: string;
      modelId: string;
      label: string;
      apiKey: string;
      baseUrl?: string;
    };

export function OrganizationModelSettings({ providers }: { providers: ConnectableProvider[] }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const procedures = queries.models.organizationConnections;
  const read = useQuery(procedures.available.queryOptions());
  const field = useId();
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const save = useSave({
    save: async (change: Change, rpc) => {
      const actions = rpc.models.organizationConnections;
      if (change.kind === "select") await actions.select({ id: change.id });
      else if (change.kind === "remove") await actions.remove({ id: change.id });
      else {
        const { kind: _kind, ...input } = change;
        await actions.create(input);
      }
    },
    stale: [procedures.available.key(), queries.me.key()],
    onSaved: (_, change) => {
      if (change.kind === "create") setAdding(false);
      if (change.kind === "remove") setRemoving(null);
    },
  });
  const view = read.data;
  if (!view || (!view.connections.length && !view.selectedId && !view.canManage)) return null;
  const options = [
    { value: "", label: t`Use saved main model` },
    ...view.connections.map((entry) => ({ value: entry.id, label: entry.label })),
  ];
  if (view.selectedId && !options.some((option) => option.value === view.selectedId))
    options.push({ value: view.selectedId, label: t`Unavailable organization model` });
  return (
    <FieldGroup className="mb-6">
      {view.connections.length || view.selectedId ? (
        <Field>
          <FieldLabel htmlFor={field}>{t`Organization override for this Space`}</FieldLabel>
          <OptionSelect
            id={field}
            options={options}
            value={view.selectedId ?? ""}
            disabled={save.pending}
            onValueChange={(id) => save.run({ kind: "select", id: id || null })}
          />
        </Field>
      ) : null}
      {view.canManage && !adding ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="sm" variant="ghost" className="self-start" disabled={save.pending} />
            }
          >
            {t`Manage organization models`}
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => setAdding(true)}>
              {t`Add organization model`}
            </DropdownMenuItem>
            {view.connections.map((entry) => (
              <DropdownMenuItem key={entry.id} onClick={() => setRemoving(entry)}>
                {t`Remove ${entry.label}`}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {view.canManage && adding ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!provider) return;
            const data = new FormData(event.currentTarget);
            save.run({
              kind: "create",
              provider,
              modelId: String(data.get("modelId")),
              label: String(data.get("label")),
              apiKey: String(data.get("apiKey")),
              baseUrl: String(data.get("baseUrl") ?? "") || undefined,
            });
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${field}-provider`}>{t`Provider`}</FieldLabel>
              <OptionSelect
                id={`${field}-provider`}
                value={provider}
                onValueChange={setProvider}
                options={providers
                  .filter((item) => !item.baseUrl)
                  .map((item) => ({ value: item.id, label: item.name }))}
              />
            </Field>
            {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
              <Field>
                <FieldLabel htmlFor={`${field}-url`}>{t`Base URL`}</FieldLabel>
                <Input id={`${field}-url`} name="baseUrl" type="url" required />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${field}-model`}>{t`Model ID`}</FieldLabel>
              <Input id={`${field}-model`} name="modelId" required />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${field}-name`}>{t`Connection name`}</FieldLabel>
              <Input id={`${field}-name`} name="label" required />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${field}-key`}>{t`API key`}</FieldLabel>
              <Input id={`${field}-key`} name="apiKey" type="password" minLength={8} required />
            </Field>
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={save.pending || !provider}
              >{t`Add organization model`}</Button>
              <Button
                type="button"
                variant="ghost"
                disabled={save.pending}
                onClick={() => {
                  save.reset();
                  setAdding(false);
                }}
              >{t`Cancel`}</Button>
            </div>
          </FieldGroup>
        </form>
      ) : null}
      {removing && view.canManage ? (
        <ConfirmDialog
          title={t`Remove ${removing.label} for everyone in the organization?`}
          confirmLabel={t`Remove`}
          busy={save.pending}
          onCancel={() => setRemoving(null)}
          onConfirm={() => save.run({ kind: "remove", id: removing.id })}
        />
      ) : null}
      {save.error ? (
        <p role="alert" className="text-destructive">
          {errorText(save.error, t`Could not save organization model`)}
        </p>
      ) : null}
    </FieldGroup>
  );
}
