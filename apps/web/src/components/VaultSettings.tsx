import { Trans, useLingui } from "@lingui/react/macro";
import type {
  BotSecretMetadata,
  LoginFieldInput,
  SettingsScope,
  VaultRevealed,
} from "@rakazo/contracts";
import {
  BotSecretName,
  commandVariableName,
  commandVariableProblem,
  encodeLoginSecret,
  isIdentityConfirmationRequired,
  LoginSecretValue,
} from "@rakazo/contracts";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web/components/ui/tooltip";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Eye, EyeOff, Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useCopyText } from "../lib/copy-text";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { useIdentityConfirmation } from "./ConfirmIdentityDialog";
import { InfoTooltip } from "./InfoTooltip";
import { LoginFieldsEditor } from "./LoginFields";

type ReadableCredentialAuth = NonNullable<BotSecretMetadata["auth"]>;
type CredentialAuthType = ReadableCredentialAuth["type"];

type Revealed = VaultRevealed & { name: string };

const fieldLabelClass = "mt-3 block text-[14px] text-muted-foreground";
/** How long a shown value stays on screen. */
export const REVEAL_MS = 30_000;
const REVEAL_CANCELLED = new Error("Reveal cancelled");

/** A command variable has no site, so its destination carries no origin. */
function credentialDestination(name: string, origin: string, auth: ReadableCredentialAuth) {
  return auth.type === "command" ? { name, auth } : { name, origin, auth };
}

/** The credentials in the account's vault, or in the bound Space's own once it customizes them. */
export function VaultSettings({
  scope,
  onBusyChange,
}: {
  scope: SettingsScope;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = queries.vault.list.queryOptions({ input: { scope } });
  const listQuery = useQuery({ ...list, refetchOnMount: "always" });
  const secrets = listQuery.data;
  const loadFailed = listQuery.isError;
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
  const newLogin = (): LoginFieldInput[] => [
    { label: t`Username`, value: "", hidden: false },
    { label: t`Password`, value: "", hidden: true },
  ];
  const [login, setLogin] = useState(newLogin);
  const [value, setValue] = useState("");
  // A shown value lives only here, never in the query cache, and hides itself after a while.
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);
  const revealAttempt = useRef(0);
  const hideTimer = useRef<number | undefined>(undefined);
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(
    () => () => {
      revealAttempt.current += 1;
      window.clearTimeout(hideTimer.current);
    },
    [],
  );

  async function refresh() {
    try {
      await fetchFresh(queryClient, list);
      return true;
    } catch {
      return false;
    }
  }

  function clearProtectedFields() {
    setValue("");
    setLogin(newLogin());
    hideRevealed();
  }

  function hideRevealed() {
    // Also drops a reveal still in flight, so it can't show after another action opened.
    revealAttempt.current += 1;
    window.clearTimeout(hideTimer.current);
    setRevealed(null);
    setRevealing(null);
  }

  async function reveal(secretName: string) {
    if (busy) return;
    clearProtectedFields();
    setReplacing(null);
    setConfirmingRemove(null);
    setAdding(false);
    setError(null);
    const attempt = revealAttempt.current;
    const current = () => revealAttempt.current === attempt;
    setRevealing(secretName);
    try {
      const shown = await withIdentityConfirmation(async () => {
        try {
          return await rpc.vault.reveal({ scope, name: secretName });
        } catch (err) {
          // A reveal cancelled while waiting must not ask the person to confirm.
          throw current() ? err : REVEAL_CANCELLED;
        }
      });
      if (!current()) return;
      setRevealed({ name: secretName, ...shown });
      hideTimer.current = window.setTimeout(hideRevealed, REVEAL_MS);
    } catch (err) {
      // Closing the confirmation is a choice, not a failure.
      if (current() && err !== REVEAL_CANCELLED && !isIdentityConfirmationRequired(err))
        setError(errorText(err, t`Could not show the credential`));
    } finally {
      if (current()) setRevealing(null);
    }
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
    if (!valueReady(destination.auth.type)) return false;
    const plaintext =
      destination.auth.type === "login" ? encodeLoginSecret({ fields: login }) : value;
    clearProtectedFields();
    setError(null);
    setBusy(true);
    try {
      await rpc.vault.put({ scope, destination, value: plaintext });
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
      await rpc.vault.remove({ scope, name: secretName });
      setConfirmingRemove(null);
      if (!(await refresh())) {
        await writeSaved(queryClient, list.queryKey, (prev = []) =>
          prev.filter((row) => row.name !== secretName),
        );
        setError(t`Could not load credentials.`);
      }
    } catch (err) {
      setError(errorText(err, t`Could not remove the credential`));
    } finally {
      setBusy(false);
    }
  }

  const secretFields = (type: CredentialAuthType, testIdPrefix: string) =>
    type === "login" ? (
      <LoginFieldsEditor fields={login} disabled={busy} onChange={setLogin} />
    ) : (
      <label htmlFor={`${ids}-${testIdPrefix}-value`} className={fieldLabelClass}>
        <Trans>Value</Trans>
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
    );

  const valueReady = (type: CredentialAuthType) =>
    type === "login" ? LoginSecretValue.safeParse({ fields: login }).success : value.length > 0;

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
    <section data-testid="vault" className="space-y-3">
      {loadFailed || secrets?.length || error || adding ? (
        <div data-testid="vault-card" className="rounded-xl bg-muted/50 p-4 [&>:first-child]:mt-0">
          {loadFailed ? (
            <p className="mt-3 text-[13px] text-destructive">
              <Trans>Could not load credentials.</Trans>
            </p>
          ) : null}
          {secrets?.length ? (
            <ul className="mt-4 space-y-4">
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
                  <li key={secret.name} data-testid="vault-credential-row">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 truncate text-[13.5px] font-medium text-foreground">
                        {secret.name}
                      </div>
                      {/* Per-row actions; each one closes the others' open forms. */}
                      {replacing !== secret.name && confirmingRemove !== secret.name ? (
                        <div className="-mt-0.5 flex shrink-0 gap-1">
                          {readableAuth !== null ? (
                            <Tooltip>
                              <TooltipTrigger
                                // The trigger's own disabled only turns off the tooltip.
                                render={
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    disabled={busy || revealing !== null}
                                  />
                                }
                                type="button"
                                aria-label={revealed?.name === secret.name ? t`Hide` : t`Show`}
                                className="text-muted-foreground"
                                data-testid={`credential-show-${secret.name}`}
                                onClick={() =>
                                  revealed?.name === secret.name
                                    ? hideRevealed()
                                    : void reveal(secret.name)
                                }
                              >
                                {revealed?.name === secret.name ? (
                                  <EyeOff className="size-4" />
                                ) : (
                                  <Eye className="size-4" />
                                )}
                              </TooltipTrigger>
                              <TooltipContent>
                                {revealed?.name === secret.name ? (
                                  <Trans>Hide</Trans>
                                ) : (
                                  <Trans>Show</Trans>
                                )}
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                          {readableAuth !== null ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={<Button variant="ghost" size="icon-xs" disabled={busy} />}
                                type="button"
                                aria-label={t`Replace value`}
                                className="text-muted-foreground"
                                data-testid={`credential-replace-${secret.name}`}
                                onClick={() => {
                                  clearProtectedFields();
                                  setConfirmingRemove(null);
                                  setAdding(false);
                                  setReplacing(secret.name);
                                }}
                              >
                                <RotateCcw className="size-4" />
                              </TooltipTrigger>
                              <TooltipContent>
                                <Trans>Replace value</Trans>
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                          <Tooltip>
                            <TooltipTrigger
                              render={<Button variant="ghost" size="icon-xs" disabled={busy} />}
                              type="button"
                              aria-label={t`Remove`}
                              className="text-muted-foreground"
                              data-testid={`credential-remove-${secret.name}`}
                              onClick={() => {
                                clearProtectedFields();
                                setReplacing(null);
                                setConfirmingRemove(secret.name);
                              }}
                            >
                              <X className="size-4" />
                            </TooltipTrigger>
                            <TooltipContent>
                              <Trans>Remove</Trans>
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      ) : null}
                    </div>
                    {secret.origin ? (
                      <div className="break-all text-[12.5px] text-muted-foreground">
                        {secret.origin}
                      </div>
                    ) : null}
                    {readableAuth === null ? (
                      <div className="flex flex-wrap gap-x-2 text-[12px]">
                        <span className="text-destructive">
                          <Trans>
                            These saved settings can't be read. Remove it and add it again.
                          </Trans>
                        </span>
                        <span className="text-muted-foreground/70">{t`Updated ${updated}`}</span>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-x-2 text-[12px] text-muted-foreground/70">
                        <span>{authLabel(readableAuth)}</span>
                        {readableAuth.type === "command" ? (
                          <span>${commandVariableName(secret.name)}</span>
                        ) : null}
                        <span>{t`Updated ${updated}`}</span>
                      </div>
                    )}
                    {readableAuth !== null && revealed?.name === secret.name ? (
                      <div data-testid="credential-revealed" className="mt-2 space-y-1">
                        {"value" in revealed ? (
                          <RevealedField testId="credential-revealed-value" text={revealed.value} />
                        ) : (
                          revealed.fields.map((field) => (
                            <RevealedField
                              key={field.label}
                              testId="credential-revealed-field"
                              label={field.label}
                              text={field.value}
                            />
                          ))
                        )}
                      </div>
                    ) : null}
                    {readableAuth !== null && replacing === secret.name ? (
                      <form
                        className="mt-1"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void submitReplace(secret);
                        }}
                      >
                        {secretFields(readableAuth.type, "credential-replace")}
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
                          <Trans>Remove {secretName}? Bots will no longer be able to use it.</Trans>
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
                    ) : null}
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
              <div className={fieldLabelClass}>
                <div className="flex items-center gap-1">
                  <label htmlFor={`${ids}-name`}>
                    <Trans>Name</Trans>
                  </label>
                  <InfoTooltip label={t`Name`}>
                    {t`Lowercase letters, numbers, hyphens and underscores, starting with a letter.`}
                  </InfoTooltip>
                </div>
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
                    {t`Available to shell commands as ${commandVariable}`}
                  </span>
                ) : null}
              </div>
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
              {secretFields(authType, "credential")}
              <div className="mt-3 flex gap-2">
                <Button
                  type="submit"
                  size="sm"
                  data-testid="credential-add-save"
                  disabled={!canAdd}
                >
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
          ) : null}
        </div>
      ) : null}
      {adding ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="credential-add"
          disabled={busy}
          onClick={() => {
            clearProtectedFields();
            setReplacing(null);
            setConfirmingRemove(null);
            setAdding(true);
          }}
        >
          <Plus />
          <Trans>Add credential</Trans>
        </Button>
      )}
      {identityDialog}
    </section>
  );
}

/** One shown value with a copy button; a login shows each of its fields this way. */
function RevealedField({ label, text, testId }: { label?: string; text: string; testId: string }) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  return (
    <div className="flex items-center gap-2 rounded-lg bg-background px-2.5 py-1.5">
      {label ? <span className="shrink-0 text-[12px] text-muted-foreground">{label}</span> : null}
      <code data-testid={testId} className="min-w-0 flex-1 break-all font-mono text-[12.5px]">
        {text}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? t`Copied` : t`Copy`}
        className="shrink-0 text-muted-foreground"
        onClick={() => copy(text)}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}
