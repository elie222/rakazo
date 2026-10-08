import { Trans, useLingui } from "@lingui/react/macro";
import type { BotSecretMetadata } from "@rakazo/contracts";
import {
  BotSecretName,
  commandVariableName,
  commandVariableProblem,
  encodeLoginSecret,
} from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

type ReadableCredentialAuth = NonNullable<BotSecretMetadata["auth"]>;
type CredentialAuthType = ReadableCredentialAuth["type"];

const fieldLabelClass = "mt-3 block text-[13px] text-muted-foreground";

/** The stored value: a website login is saved as one encoded username and password pair. */
function credentialPlaintext(type: CredentialAuthType, username: string, value: string) {
  return type === "login" ? encodeLoginSecret({ username, password: value }) : value;
}

/** A command variable has no site, so its destination carries no origin. */
function credentialDestination(name: string, origin: string, auth: ReadableCredentialAuth) {
  return auth.type === "command" ? { name, auth } : { name, origin, auth };
}

export function BotCredentialsSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const ids = useId();
  const [secrets, setSecrets] = useState<BotSecretMetadata[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [authType, setAuthType] = useState<CredentialAuthType>("bearer");
  const [headerName, setHeaderName] = useState("");
  const [basicUsername, setBasicUsername] = useState("");
  const [replacing, setReplacing] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  // Protected fields: held only in component state and cleared on every submit or cancel.
  const [loginUsername, setLoginUsername] = useState("");
  const [value, setValue] = useState("");

  useEffect(() => {
    let active = true;
    rpc.botSecrets
      .list({ botId })
      .then((rows) => {
        if (!active) return;
        setSecrets(rows);
        setLoadFailed(false);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [botId]);

  async function refresh() {
    try {
      setSecrets(await rpc.botSecrets.list({ botId }));
      setLoadFailed(false);
      return true;
    } catch {
      setLoadFailed(true);
      return false;
    }
  }

  function clearProtectedFields() {
    setValue("");
    setLoginUsername("");
  }

  function authLabel(auth: ReadableCredentialAuth) {
    if (auth.type === "header") {
      const header = auth.name;
      return t`Header "${header}"`;
    }
    if (auth.type === "basic") {
      const username = auth.username;
      return t`Basic auth (${username})`;
    }
    if (auth.type === "login") return t`Website login`;
    if (auth.type === "command") return t`Command variable`;
    return t`Bearer token`;
  }

  function newAuth(): ReadableCredentialAuth {
    if (authType === "header") return { type: "header", name: headerName.trim() };
    if (authType === "basic") return { type: "basic", username: basicUsername.trim() };
    if (authType === "login") return { type: "login" };
    if (authType === "command") return { type: "command" };
    return { type: "bearer" };
  }

  async function save(destination: {
    name: string;
    origin?: string;
    auth: ReadableCredentialAuth;
  }) {
    const username = loginUsername.trim();
    const secretValue = value;
    clearProtectedFields();
    setError(null);
    let plaintext: string;
    try {
      plaintext = credentialPlaintext(destination.auth.type, username, secretValue);
    } catch {
      setError(t`Enter a username and password`);
      return false;
    }
    setBusy(true);
    try {
      await rpc.botSecrets.put({ botId, destination, value: plaintext });
      if (!(await refresh())) {
        setError(t`Could not load credentials.`);
        return false;
      }
      return true;
    } catch (err) {
      setError(errorText(err, t`Could not save the credential`));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitAdd() {
    if (busy || !canAdd) return;
    const saved = await save(credentialDestination(name.trim(), origin.trim(), newAuth()));
    if (!saved) return;
    setAdding(false);
    setName("");
    setOrigin("");
    setAuthType("bearer");
    setHeaderName("");
    setBasicUsername("");
  }

  async function submitReplace(secret: BotSecretMetadata) {
    if (busy || !secret.auth) return;
    const saved = await save(credentialDestination(secret.name, secret.origin, secret.auth));
    if (saved) setReplacing(null);
  }

  async function confirmRemove(secretName: string) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await rpc.botSecrets.remove({ botId, name: secretName });
      setConfirmingRemove(null);
      if (!(await refresh())) {
        setSecrets((prev) => prev?.filter((row) => row.name !== secretName) ?? null);
        setError(t`Could not load credentials.`);
      }
    } catch (err) {
      setError(errorText(err, t`Could not remove the credential`));
    } finally {
      setBusy(false);
    }
  }

  const loginFields = (type: CredentialAuthType, testIdPrefix: string) => (
    <>
      {type === "login" ? (
        <label htmlFor={`${ids}-${testIdPrefix}-username`} className={fieldLabelClass}>
          <Trans>Username</Trans>
          <Input
            id={`${ids}-${testIdPrefix}-username`}
            data-testid={`${testIdPrefix}-username`}
            // "off" is ignored for username fields; this stops browsers saving the pair.
            autoComplete="new-password"
            spellCheck={false}
            value={loginUsername}
            onChange={(event) => setLoginUsername(event.target.value)}
            className="mt-1.5"
          />
        </label>
      ) : null}
      <label htmlFor={`${ids}-${testIdPrefix}-value`} className={fieldLabelClass}>
        {type === "login" ? <Trans>Password</Trans> : <Trans>Value</Trans>}
        <Input
          id={`${ids}-${testIdPrefix}-value`}
          data-testid={`${testIdPrefix}-value`}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="mt-1.5"
        />
      </label>
    </>
  );

  const valueReady = (type: CredentialAuthType) =>
    value.length > 0 && (type !== "login" || loginUsername.trim().length > 0);

  const nameValid = BotSecretName.safeParse(name.trim()).success;
  // Shown live while a command variable is named, so a reserved name is caught before saving.
  const commandVariable =
    authType === "command" && nameValid ? `$${commandVariableName(name.trim())}` : null;
  const commandVariableError =
    commandVariable && commandVariableProblem(commandVariable.slice(1))
      ? t`${commandVariable} is reserved and cannot be used as a command variable. Choose another name.`
      : null;

  const canAdd =
    !busy &&
    nameValid &&
    (authType === "command" ? !commandVariableError : origin.trim().length > 0) &&
    (authType !== "header" || headerName.trim().length > 0) &&
    (authType !== "basic" || basicUsername.trim().length > 0) &&
    valueReady(authType);

  return (
    <section data-testid="bot-credentials" className="mt-5 border-t border-border/20 pt-4">
      <div className="text-[13.5px] font-medium text-foreground">
        <Trans>Credentials</Trans>
      </div>
      <p className="mt-0.5 text-[12px] text-muted-foreground/70">
        <Trans>Values are encrypted and never shown again.</Trans>
      </p>
      {loadFailed ? (
        <p className="mt-3 text-[13px] text-destructive">
          <Trans>Could not load credentials.</Trans>
        </p>
      ) : null}
      {secrets && secrets.length === 0 ? (
        <p data-testid="bot-credentials-empty" className="mt-3 text-[13px] text-muted-foreground">
          <Trans>No credentials saved for this bot.</Trans>
        </p>
      ) : null}
      {secrets?.length ? (
        <ul className="mt-3 space-y-2">
          {secrets.map((secret) => {
            const secretName = secret.name;
            const updated = new Date(secret.updatedAt).toLocaleDateString();
            // A readable auth on a name outside the current pattern cannot be replaced:
            // only the loose remove input accepts it, so show the unreadable row instead.
            const readableAuth =
              secret.auth !== null && BotSecretName.safeParse(secret.name).success
                ? secret.auth
                : null;
            return (
              <li
                key={secret.name}
                data-testid="bot-credential-row"
                className="rounded-lg border border-border/40 px-3 py-2.5"
              >
                <div className="truncate text-[13.5px] font-medium text-foreground">
                  {secret.name}
                </div>
                {secret.origin ? (
                  <div className="break-all text-[12.5px] text-muted-foreground">
                    {secret.origin}
                  </div>
                ) : null}
                {readableAuth === null ? (
                  <div className="text-[12px] text-destructive">
                    <Trans>These saved settings can't be read. Remove it and add it again.</Trans> ·{" "}
                    {t`Updated ${updated}`}
                  </div>
                ) : (
                  <div className="text-[12px] text-muted-foreground/70">
                    {authLabel(readableAuth)}
                    {readableAuth.type === "command"
                      ? ` · $${commandVariableName(secret.name)}`
                      : null}{" "}
                    · {t`Updated ${updated}`}
                  </div>
                )}
                {readableAuth !== null && replacing === secret.name ? (
                  <form
                    className="mt-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitReplace(secret);
                    }}
                  >
                    {loginFields(readableAuth.type, "credential-replace")}
                    <div className="mt-3 flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        data-testid="credential-replace-save"
                        disabled={busy || !valueReady(readableAuth.type)}
                      >
                        <Trans>Save new value</Trans>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          clearProtectedFields();
                          setReplacing(null);
                        }}
                      >
                        <Trans>Cancel</Trans>
                      </Button>
                    </div>
                  </form>
                ) : confirmingRemove === secret.name ? (
                  <div className="mt-2">
                    <p className="text-[13px] text-foreground">
                      <Trans>Remove {secretName}? This bot will no longer be able to use it.</Trans>
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="text-destructive hover:text-destructive"
                        data-testid={`credential-remove-confirm-${secret.name}`}
                        disabled={busy}
                        onClick={() => void confirmRemove(secret.name)}
                      >
                        <Trans>Remove</Trans>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmingRemove(null)}
                      >
                        <Trans>Cancel</Trans>
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1.5 flex gap-1">
                    {readableAuth !== null ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="-ms-2.5"
                        data-testid={`credential-replace-${secret.name}`}
                        disabled={busy}
                        onClick={() => {
                          clearProtectedFields();
                          setConfirmingRemove(null);
                          setAdding(false);
                          setReplacing(secret.name);
                        }}
                      >
                        <Trans>Replace value</Trans>
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      data-testid={`credential-remove-${secret.name}`}
                      disabled={busy}
                      onClick={() => {
                        clearProtectedFields();
                        setReplacing(null);
                        setConfirmingRemove(secret.name);
                      }}
                    >
                      <Trans>Remove</Trans>
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      {adding ? (
        <form
          data-testid="credential-add-form"
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAdd();
          }}
        >
          <label htmlFor={`${ids}-name`} className={fieldLabelClass}>
            <Trans>Name</Trans>
            <Input
              id={`${ids}-name`}
              data-testid="credential-name"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="github"
              className="mt-1.5"
            />
            <span className="mt-1 block text-[12px] text-muted-foreground/70">
              <Trans>
                Lowercase letters, numbers, hyphens and underscores, starting with a letter.
              </Trans>
            </span>
            {commandVariableError ? (
              <span
                data-testid="credential-command-variable-error"
                className="mt-1 block text-[12px] text-destructive"
              >
                {commandVariableError}
              </span>
            ) : commandVariable ? (
              <span
                data-testid="credential-command-variable"
                className="mt-1 block text-[12px] text-muted-foreground"
              >
                {t`Available to this bot's shell commands as ${commandVariable}`}
              </span>
            ) : null}
          </label>
          {authType === "command" ? null : (
            <label htmlFor={`${ids}-origin`} className={fieldLabelClass}>
              <Trans>Site</Trans>
              <Input
                id={`${ids}-origin`}
                data-testid="credential-origin"
                autoComplete="off"
                spellCheck={false}
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                placeholder="https://api.example.com"
                className="mt-1.5"
              />
            </label>
          )}
          <label htmlFor={`${ids}-auth`} className={fieldLabelClass}>
            <Trans>Type</Trans>
            <NativeSelect
              id={`${ids}-auth`}
              data-testid="credential-auth-type"
              className="mt-1.5 w-full"
              value={authType}
              onChange={(event) => setAuthType(event.target.value as CredentialAuthType)}
            >
              <NativeSelectOption value="bearer">{t`Bearer token`}</NativeSelectOption>
              <NativeSelectOption value="header">{t`Custom header`}</NativeSelectOption>
              <NativeSelectOption value="basic">{t`Basic auth`}</NativeSelectOption>
              <NativeSelectOption value="login">{t`Website login`}</NativeSelectOption>
              <NativeSelectOption value="command">{t`Command variable`}</NativeSelectOption>
            </NativeSelect>
          </label>
          {authType === "header" ? (
            <label htmlFor={`${ids}-header`} className={fieldLabelClass}>
              <Trans>Header name</Trans>
              <Input
                id={`${ids}-header`}
                data-testid="credential-header-name"
                autoComplete="off"
                spellCheck={false}
                value={headerName}
                onChange={(event) => setHeaderName(event.target.value)}
                placeholder="X-Api-Key"
                className="mt-1.5"
              />
            </label>
          ) : null}
          {authType === "basic" ? (
            <label htmlFor={`${ids}-basic-username`} className={fieldLabelClass}>
              <Trans>Username</Trans>
              <Input
                id={`${ids}-basic-username`}
                data-testid="credential-basic-username"
                autoComplete="off"
                spellCheck={false}
                value={basicUsername}
                onChange={(event) => setBasicUsername(event.target.value)}
                className="mt-1.5"
              />
            </label>
          ) : null}
          {loginFields(authType, "credential")}
          <div className="mt-3 flex gap-2">
            <Button type="submit" size="sm" data-testid="credential-add-save" disabled={!canAdd}>
              {busy ? <Trans>Saving…</Trans> : <Trans>Save credential</Trans>}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                clearProtectedFields();
                setAdding(false);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-3"
          data-testid="credential-add"
          onClick={() => {
            clearProtectedFields();
            setReplacing(null);
            setConfirmingRemove(null);
            setAdding(true);
          }}
        >
          <Trans>Add credential</Trans>
        </Button>
      )}
    </section>
  );
}
