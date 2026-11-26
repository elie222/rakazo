import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Checkbox,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { passwordManagerIgnore } from "../../components/vault/password-manager-ignore";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

export function OrganizationVaultSettings({ onBack }: { onBack: () => void }) {
  const options = useSpaceQueries().organizations.vault.settings.queryOptions();
  const settings = useQuery({ ...options, refetchOnWindowFocus: true });
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const create = useSave({
    save: (input: { name: string; origin: string }, rpc) =>
      rpc.organizations.vault.create({ ...input, botIds: [] }),
    stale: [options.queryKey],
    onSaved: (login) => {
      setAdding(false);
      setSelected(login.id);
    },
  });
  const id = useId();

  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onBack}>
        <Trans>Back</Trans>
      </Button>
      <SectionHeading>
        <Trans>Shared logins</Trans>
      </SectionHeading>
      {settings.isError && <p role="alert">{errorText(settings.error)}</p>}
      {settings.isPending && (
        <p role="status">
          <Trans>Loading…</Trans>
        </p>
      )}
      {settings.data?.logins.map((login) => (
        <div key={login.id} className="rounded-lg border p-3">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-4 text-start"
            aria-expanded={selected === login.id}
            onClick={() => setSelected(selected === login.id ? null : login.id)}
          >
            <span>{login.name}</span>
            <span className="text-body-sm text-muted-foreground">
              {login.hasSession ? <Trans>Session saved</Trans> : <Trans>No session</Trans>}
            </span>
          </button>
          {selected === login.id && (
            <LoginActions
              key={JSON.stringify(login.botIds)}
              login={login}
              agents={settings.data.agents}
              signInAvailable={settings.data.signInAvailable}
              stale={options.queryKey}
            />
          )}
        </div>
      ))}
      {adding ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            create.run({ name: String(data.get("name")), origin: String(data.get("origin")) });
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>
                <Trans>Name</Trans>
              </FieldLabel>
              <Input id={`${id}-name`} name="name" maxLength={100} required />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-site`}>
                <Trans>Website</Trans>
              </FieldLabel>
              <Input id={`${id}-site`} name="origin" type="url" maxLength={2048} required />
            </Field>
            {create.error && <p role="alert">{errorText(create.error)}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={create.pending}>
                <Trans>Add login</Trans>
              </Button>
              <Button variant="ghost" disabled={create.pending} onClick={() => setAdding(false)}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </FieldGroup>
        </form>
      ) : settings.data?.signInAvailable ? (
        <Button
          variant="outline"
          onClick={() => {
            create.reset();
            setAdding(true);
          }}
        >
          <Trans>Add login</Trans>
        </Button>
      ) : (
        settings.data && (
          <p className="text-body-sm text-muted-foreground">
            <Trans>Protected sign-in is unavailable.</Trans>
          </p>
        )
      )}
    </div>
  );
}

function LoginActions({
  login,
  agents,
  signInAvailable,
  stale,
}: {
  login: { id: string; origin: string; botIds: string[]; hasSession: boolean };
  agents: { id: string; name: string }[];
  signInAvailable: boolean;
  stale: readonly unknown[];
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState<"signIn" | "agents" | "revoke" | "remove" | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const id = useId();
  const save = useSave({
    save: async (action: NonNullable<typeof editing>, rpc) => {
      const loginId = login.id;
      if (action === "revoke") return rpc.organizations.vault.revokeSession({ loginId });
      if (action === "remove") return rpc.organizations.vault.remove({ loginId });
      const data = new FormData(form.current ?? undefined);
      if (action === "agents")
        return rpc.organizations.vault.setAgents({
          loginId,
          botIds: data.getAll("agent").map(String),
        });
      for (const name of ["username", "password"]) {
        const credential = form.current?.elements.namedItem(name);
        if (credential instanceof HTMLInputElement) credential.value = "";
      }
      return rpc.organizations.vault.signIn({
        loginId,
        url: String(data.get("url") ?? ""),
        usernameLabel: String(data.get("usernameLabel") ?? ""),
        username: String(data.get("username") ?? ""),
        passwordLabel: String(data.get("passwordLabel") ?? ""),
        password: String(data.get("password") ?? ""),
        submitLabel: String(data.get("submitLabel") ?? ""),
        successHeading: String(data.get("successHeading") ?? ""),
      });
    },
    stale: [stale],
    onSaved: () => setEditing(null),
  });
  const fields = [
    { name: "url", label: t`Sign-in page`, type: "url", defaultValue: login.origin },
    { name: "usernameLabel", label: t`Username field label`, type: "text" },
    { name: "username", label: t`Username`, type: "text" },
    { name: "passwordLabel", label: t`Password field label`, type: "text" },
    { name: "password", label: t`Password`, type: "password" },
    { name: "submitLabel", label: t`Sign-in button label`, type: "text" },
    { name: "successHeading", label: t`Heading after sign-in`, type: "text" },
  ];
  function edit(action: typeof editing) {
    save.reset();
    setEditing(action);
  }
  return (
    <div className="mt-3 space-y-3">
      <p className="break-all text-body-sm text-muted-foreground">{login.origin}</p>
      {editing ? (
        <form
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            save.run(editing);
          }}
        >
          <FieldGroup>
            {editing === "signIn" &&
              fields.map((field) => (
                <Field key={field.name}>
                  <FieldLabel htmlFor={`${id}-${field.name}`}>{field.label}</FieldLabel>
                  <Input
                    id={`${id}-${field.name}`}
                    name={field.name}
                    type={field.type}
                    defaultValue={field.defaultValue}
                    autoComplete="new-password"
                    {...passwordManagerIgnore}
                    spellCheck={false}
                    disabled={save.pending}
                    required
                  />
                </Field>
              ))}
            {editing === "agents" && (
              <fieldset className="space-y-2" disabled={save.pending}>
                <legend>
                  <Trans>Allowed agents</Trans>
                </legend>
                {agents.map((agent) => (
                  <Field key={agent.id} orientation="horizontal">
                    <Checkbox
                      id={`${id}-agent-${agent.id}`}
                      disabled={save.pending}
                      name="agent"
                      value={agent.id}
                      defaultChecked={login.botIds.includes(agent.id)}
                    />
                    <FieldLabel htmlFor={`${id}-agent-${agent.id}`}>{agent.name}</FieldLabel>
                  </Field>
                ))}
              </fieldset>
            )}
            {editing === "revoke" && (
              <p>
                <Trans>Remove this saved session?</Trans>
              </p>
            )}
            {editing === "remove" && (
              <p>
                <Trans>Delete this shared login and its session?</Trans>
              </p>
            )}
            {save.error && <p role="alert">{errorText(save.error)}</p>}
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={save.pending}
                variant={editing === "remove" || editing === "revoke" ? "destructive" : "default"}
              >
                {editing === "signIn" ? (
                  <Trans>Save session</Trans>
                ) : editing === "agents" ? (
                  <Trans>Save access</Trans>
                ) : editing === "revoke" ? (
                  <Trans>Revoke session</Trans>
                ) : (
                  <Trans>Delete login</Trans>
                )}
              </Button>
              <Button variant="ghost" disabled={save.pending} onClick={() => edit(null)}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </FieldGroup>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {signInAvailable && (
            <Button variant="outline" onClick={() => edit("signIn")}>
              <Trans>Sign in</Trans>
            </Button>
          )}
          <Button variant="ghost" onClick={() => edit("agents")}>
            <Trans>Manage access</Trans>
          </Button>
          {login.hasSession && (
            <Button variant="ghost" onClick={() => edit("revoke")}>
              <Trans>Revoke session</Trans>
            </Button>
          )}
          <Button variant="ghost" onClick={() => edit("remove")}>
            <Trans>Delete login</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}
