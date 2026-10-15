import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ExecutionInputModality,
  ExecutionProfile,
  ExecutionProfileModel,
  ModelCredential,
  NativeLoginAccount,
  NativeLoginComputer,
} from "@rakazo/contracts";
import {
  CreateExecutionProfileInput,
  EXECUTION_HARNESS_LABELS,
  EXECUTION_HARNESS_PROTOCOLS,
  EXECUTION_HARNESS_VERSIONS,
  NATIVE_EXECUTION_CAPABILITIES,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  supportedExecutionInputModalities,
} from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption, Switch } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

type Harness = ExecutionProfile["harness"];
type Protocol = ExecutionProfile["protocol"];

const fieldClass = "mt-3 block text-[13px] text-muted-foreground";

/** Profiles hold references only. Credentials are always selected by their exact connection ID. */
export function ExecutionProfileSettings({
  value,
  currentProfile,
  onChange,
}: {
  value: string | null;
  currentProfile?: ExecutionProfile | null;
  onChange: (profileId: string | null) => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [profiles, setProfiles] = useState<ExecutionProfile[]>([]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [nativeAccounts, setNativeAccounts] = useState<NativeLoginAccount[]>([]);
  const [computers, setComputers] = useState<NativeLoginComputer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [harness, setHarness] = useState<Harness>("claude");
  const runtimeVersion = EXECUTION_HARNESS_VERSIONS[harness];
  const [provider, setProvider] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("anthropic");
  const [endpoint, setEndpoint] = useState("");
  const [modelId, setModelId] = useState("");
  const [inputModalities, setInputModalities] = useState<ExecutionInputModality[]>([]);
  const [supersedesId, setSupersedesId] = useState<string>();
  const [computerId, setComputerId] = useState<string | null>(null);
  const [authScheme, setAuthScheme] = useState<"api-key" | "bearer">("api-key");
  const [modelRoles, setModelRoles] = useState<ExecutionProfile["modelRoles"]>({});
  const [modelOptions, setModelOptions] = useState<ExecutionProfileModel[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsError, setModelsError] = useState(false);
  const [modelRefresh, setModelRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setLoadError(false);
    void Promise.all([
      rpc.executionProfiles.list(),
      rpc.models.credentials(),
      rpc.nativeLogins.list(),
    ])
      .then(([nextProfiles, nextCredentials, nativeLogins]) => {
        if (!active) return;
        setProfiles(nextProfiles);
        setCredentials(nextCredentials);
        setNativeAccounts(nativeLogins.accounts);
        setComputers(nativeLogins.computers);
        setLoaded(true);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    let current = true;
    setModelOptions([]);
    setModelsLoaded(false);
    setModelsError(false);
    if (!creating || !credentialId) return;
    void rpc.executionProfiles
      .models({ harness, credentialId })
      .then((models) => {
        if (!current) return;
        setModelOptions(models);
        setModelsLoaded(true);
        if (harness === "pi" && models.length) {
          setProtocol(
            models.find((entry) => entry.id === modelId)?.protocol ?? models[0]!.protocol,
          );
        }
      })
      .catch(() => {
        if (current) setModelsError(true);
      });
    return () => {
      current = false;
    };
  }, [harness, credentialId, creating, modelRefresh]);

  const selected =
    profiles.find((profile) => profile.id === value) ??
    (currentProfile?.id === value ? currentProfile : undefined);
  const nativeProfile = selected?.harness !== "pi" ? selected : undefined;
  const unsupportedVersion =
    selected && selected.runtimeVersion !== EXECUTION_HARNESS_VERSIONS[selected.harness];
  const transportInputs = nativeProfile ? supportedExecutionInputModalities(nativeProfile) : [];
  const inputLabels = { image: t`image input`, audio: t`uploaded audio` };
  const unsupportedInputs = nativeProfile
    ? (["image", "audio"] as const)
        .filter((kind) => !transportInputs.includes(kind))
        .map((kind) => inputLabels[kind])
        .join(", ")
    : "";
  const undeclaredInputs = nativeProfile
    ? transportInputs
        .filter((kind) => !nativeProfile.inputModalities?.includes(kind))
        .map((kind) => inputLabels[kind])
        .join(", ")
    : "";
  const knownModel = modelOptions.find((entry) => entry.id === modelId);
  const allowCustomModel = harness !== "pi" || provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const creatableInputs = supportedExecutionInputModalities({
    harness,
    protocol,
    runtimeVersion,
    endpoint: endpoint.trim() || null,
  }).filter((kind) => !knownModel || knownModel.inputModalities.includes(kind));
  const signedInCredentials: ModelCredential[] = nativeAccounts.map((account) => ({
    id: account.credentialId,
    provider: `native-${account.harness}`,
    label: account.label,
    hasKey: account.state.state === "ready",
    isDefault: false,
    baseUrl: account.endpoint,
  }));
  const account = [...credentials, ...signedInCredentials].find(
    (credential) => credential.id === selected?.credentialId,
  );
  const selectedUsesNativeLogin =
    selected?.provider === "native-codex" || selected?.provider === "native-kimi";
  const chosenNativeAccount = nativeAccounts.find(
    (account) => account.credentialId === credentialId,
  );
  function computerLabel(computer: NativeLoginComputer): string {
    return computer.scope === "team" ? t`Team computer` : computer.botName || t`Private computer`;
  }

  const availableCredentials = [
    ...credentials.filter(
      (credential) => credential.hasKey && (harness === "pi" || credential.authKind !== "oauth"),
    ),
    ...signedInCredentials.filter(
      (credential) => credential.hasKey && credential.provider === `native-${harness}`,
    ),
  ];
  const providers = [...new Set(availableCredentials.map((credential) => credential.provider))];
  const accounts = availableCredentials.filter((credential) => credential.provider === provider);
  const chosenAccount = accounts.find((credential) => credential.id === credentialId);
  const canCreate =
    loaded &&
    name.trim() &&
    runtimeVersion.trim() &&
    provider &&
    chosenAccount &&
    modelId.trim() &&
    (harness !== "pi" ||
      (modelsLoaded && (knownModel || (allowCustomModel && modelOptions.length > 0)))) &&
    (harness === "pi" || endpoint.trim());

  function resetForm() {
    setCreating(false);
    setName("");
    setProvider("");
    setCredentialId("");
    setEndpoint("");
    setModelId("");
    setInputModalities([]);
    setSupersedesId(undefined);
    setComputerId(null);
    setAuthScheme("api-key");
    setModelRoles({});
    setError(null);
  }

  async function createProfile() {
    if (!canCreate || pendingRef.current) return;
    const parsed = CreateExecutionProfileInput.safeParse({
      name,
      harness,
      runtimeVersion,
      provider,
      credentialId,
      protocol,
      endpoint: endpoint.trim() || null,
      modelId,
      inputModalities,
      ...(supersedesId ? { supersedesId } : {}),
      computerId,
      authScheme,
      modelRoles,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t`Check the profile fields`);
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const profile = await rpc.executionProfiles.create(parsed.data);
      if (!active.current) return;
      setProfiles((current) => [...current.filter((entry) => entry.id !== profile.id), profile]);
      onChange(profile.id);
      resetForm();
    } catch (err) {
      if (active.current) setError(errorText(err, t`Could not create profile`));
    } finally {
      pendingRef.current = false;
      if (active.current) setPending(false);
    }
  }

  return (
    <section data-testid="execution-profile-settings" className="mt-4">
      <label htmlFor={`${ids}-profile`} className={fieldClass}>
        <Trans>Execution profile</Trans>
        <NativeSelect
          id={`${ids}-profile`}
          className="mt-2 w-full"
          value={value ?? ""}
          disabled={pending}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <NativeSelectOption value="">{t`Pi (default)`}</NativeSelectOption>
          {value && !profiles.some((profile) => profile.id === value) ? (
            <NativeSelectOption value={value}>
              {selected?.name ?? t`Unavailable profile`}
            </NativeSelectOption>
          ) : null}
          {profiles.map((profile) => (
            <NativeSelectOption key={profile.id} value={profile.id}>
              {profile.name} · {EXECUTION_HARNESS_LABELS[profile.harness]} · v{profile.revision}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      {loadError ? (
        <div role="alert" className="mt-2 text-[13px] text-destructive">
          <Trans>Could not load execution profiles</Trans>{" "}
          <Button variant="link" size="sm" onClick={() => setRefresh((value) => value + 1)}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {selected ? (
        <div data-testid="execution-profile-effective" className="mt-3 text-[13px]">
          <dl className="space-y-1">
            {[
              [
                t`Harness`,
                `${EXECUTION_HARNESS_LABELS[selected.harness]} · ${selected.runtimeVersion}`,
              ],
              [t`Provider`, selected.provider],
              [t`Protocol`, selected.protocol],
              [t`Model`, selected.modelId],
              [t`Account`, account?.label ?? (loaded ? t`Unavailable account` : t`Loading…`)],
              [t`Environment`, selected.computerId ? t`Pinned computer` : t`Bot computer`],
              ...(selected.endpoint ? [[t`Endpoint`, selected.endpoint]] : []),
            ].map(([label, detail]) => (
              <div key={label} className="flex gap-3">
                <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-words">{detail}</dd>
              </div>
            ))}
          </dl>
          {unsupportedVersion ? (
            <p role="alert" className="mt-2 text-destructive">
              <Trans>Unsupported runtime version. Create a new revision.</Trans>
            </p>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={!loaded || pending || creating}
            onClick={() => {
              setName(selected.name);
              setHarness(selected.harness);
              setProtocol(selected.protocol);
              setProvider(selected.provider);
              setCredentialId(selected.credentialId);
              setEndpoint(selected.endpoint ?? "");
              setModelId(selected.modelId);
              setInputModalities(unsupportedVersion ? [] : (selected.inputModalities ?? []));
              setComputerId(selected.computerId);
              setAuthScheme(selected.authScheme ?? "api-key");
              setModelRoles(selected.modelRoles ?? {});
              setSupersedesId(selected.id);
              setError(null);
              setCreating(true);
            }}
          >
            <Trans>New revision</Trans>
          </Button>
          {selected.harness !== "pi" &&
          NATIVE_EXECUTION_CAPABILITIES.requiresRestrictedLinuxDocker ? (
            <p className="mt-2 text-muted-foreground">
              <Trans>Requires an enabled Linux Docker runtime.</Trans>
            </p>
          ) : null}
          {unsupportedInputs ? (
            <p className="mt-1 text-muted-foreground">{t`Unavailable: ${unsupportedInputs}`}</p>
          ) : null}
          {undeclaredInputs ? (
            <p className="mt-1 text-muted-foreground">
              {t`Not enabled for this model: ${undeclaredInputs}`}
            </p>
          ) : null}
          {nativeProfile && !nativeProfile.inputModalities?.includes("audio") ? (
            <p className="mt-1 text-muted-foreground">
              <Trans>Live calls use transcripts.</Trans>
            </p>
          ) : null}
          {selectedUsesNativeLogin ? (
            <p className="mt-1 text-muted-foreground">
              <Trans>Delegated agents are unavailable for signed-in accounts.</Trans>{" "}
              <Trans>Group handoffs remain available.</Trans>
            </p>
          ) : null}
          {selected?.provider === "native-kimi" ? (
            <p className="mt-1 text-muted-foreground">
              <Trans>Personal interactive chats only.</Trans>
            </p>
          ) : null}
          {loaded && !account?.hasKey ? (
            <p role="alert" className="text-destructive">
              <Trans>This profile’s account is unavailable. Choose another profile.</Trans>
            </p>
          ) : null}
        </div>
      ) : null}
      {value && !selected && loaded ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          <Trans>This profile is unavailable. Choose another profile.</Trans>
        </p>
      ) : null}
      {!creating ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 -ms-2.5"
          disabled={!loaded}
          onClick={() => setCreating(true)}
        >
          <Trans>New profile</Trans>
        </Button>
      ) : (
        <div
          data-testid="execution-profile-create"
          className="mt-3 rounded-lg border border-border p-3"
        >
          <fieldset disabled={pending}>
            <label htmlFor={`${ids}-name`} className={fieldClass}>
              <Trans>Profile name</Trans>
              <Input
                id={`${ids}-name`}
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                className="mt-1.5"
              />
            </label>
            <label htmlFor={`${ids}-harness`} className={fieldClass}>
              <Trans>Harness</Trans>
              <NativeSelect
                id={`${ids}-harness`}
                className="mt-1.5 w-full"
                value={harness}
                onChange={(event) => {
                  const next = event.target.value as Harness;
                  setHarness(next);
                  setAuthScheme("api-key");
                  setModelRoles({});
                  setProtocol(EXECUTION_HARNESS_PROTOCOLS[next][0]);
                  setProvider("");
                  setCredentialId("");
                  setEndpoint("");
                  setModelId("");
                  setInputModalities([]);
                }}
              >
                {Object.entries(EXECUTION_HARNESS_LABELS).map(([key, label]) => (
                  <NativeSelectOption key={key} value={key}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label htmlFor={`${ids}-version`} className={fieldClass}>
              <Trans>Runtime version</Trans>
              <Input
                id={`${ids}-version`}
                value={runtimeVersion}
                readOnly
                className="mt-1.5"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            <label htmlFor={`${ids}-provider`} className={fieldClass}>
              <Trans>Provider</Trans>
              <NativeSelect
                id={`${ids}-provider`}
                className="mt-1.5 w-full"
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value);
                  setCredentialId("");
                  setEndpoint("");
                  setModelId("");
                  setInputModalities([]);
                }}
              >
                <NativeSelectOption value="">{t`Choose provider`}</NativeSelectOption>
                {providers.map((entry) => (
                  <NativeSelectOption key={entry} value={entry}>
                    {entry}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label htmlFor={`${ids}-protocol`} className={fieldClass}>
              <Trans>Protocol</Trans>
              <NativeSelect
                id={`${ids}-protocol`}
                disabled={harness === "pi"}
                className="mt-1.5 w-full"
                value={protocol}
                onChange={(event) => {
                  setProtocol(event.target.value as Protocol);
                  setCredentialId("");
                  setEndpoint("");
                  setModelId("");
                  setInputModalities([]);
                }}
              >
                {EXECUTION_HARNESS_PROTOCOLS[harness].map((entry) => (
                  <NativeSelectOption key={entry} value={entry}>
                    {entry}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label htmlFor={`${ids}-account`} className={fieldClass}>
              <Trans>Account</Trans>
              <NativeSelect
                id={`${ids}-account`}
                className="mt-1.5 w-full"
                value={credentialId}
                onChange={(event) => {
                  const next = accounts.find((account) => account.id === event.target.value);
                  setCredentialId(event.target.value);
                  const signedIn = nativeAccounts.find(
                    (account) => account.credentialId === event.target.value,
                  );
                  setComputerId(
                    signedIn?.computerId ?? (supersedesId ? (selected?.computerId ?? null) : null),
                  );
                  setEndpoint(
                    harness === "pi" && provider !== OPENAI_COMPATIBLE_PROVIDER_ID
                      ? ""
                      : (next?.baseUrl ?? ""),
                  );
                  setModelId(next?.modelId ?? "");
                  setInputModalities([]);
                }}
              >
                <NativeSelectOption value="">{t`Choose account`}</NativeSelectOption>
                {accounts.map((entry) => (
                  <NativeSelectOption key={entry.id} value={entry.id}>
                    {entry.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            {!availableCredentials.length ? (
              <p className="mt-2 text-[13px] text-muted-foreground">
                <Trans>Connect an account in Models first.</Trans>
              </p>
            ) : null}
            {modelOptions.length ? (
              <label htmlFor={`${ids}-model-choice`} className={fieldClass}>
                <Trans>Model</Trans>
                <NativeSelect
                  id={`${ids}-model-choice`}
                  className="mt-1.5 w-full"
                  value={knownModel ? modelId : ""}
                  onChange={(event) => {
                    const next = modelOptions.find((entry) => entry.id === event.target.value);
                    setModelId(event.target.value);
                    if (harness === "pi" && next) setProtocol(next.protocol);
                    setInputModalities([]);
                  }}
                >
                  <NativeSelectOption value="">
                    {allowCustomModel ? t`Other model…` : t`Choose model`}
                  </NativeSelectOption>
                  {modelOptions.map((entry) => (
                    <NativeSelectOption key={entry.id} value={entry.id}>
                      {entry.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
            ) : null}
            {allowCustomModel && !knownModel ? (
              <label htmlFor={`${ids}-model`} className={fieldClass}>
                {modelOptions.length ? t`Model id` : t`Model`}
                <Input
                  id={`${ids}-model`}
                  value={modelId}
                  onChange={(event) => {
                    setModelId(event.target.value);
                    setInputModalities([]);
                  }}
                  className="mt-1.5"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </label>
            ) : null}
            {modelsError ? (
              <p role="alert" className="mt-2 text-[13px] text-destructive">
                <Trans>Could not load models</Trans>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setModelRefresh((value) => value + 1)}
                >
                  <Trans>Retry</Trans>
                </Button>
              </p>
            ) : null}
            {harness === "pi" && credentialId && modelsLoaded && !modelOptions.length ? (
              <p role="alert" className="mt-2 text-[13px] text-destructive">
                <Trans>This account’s protocol is not supported by execution profiles.</Trans>
              </p>
            ) : null}
            {harness !== "pi" || provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
              <label htmlFor={`${ids}-endpoint`} className={fieldClass}>
                {harness === "pi" ? t`Endpoint (optional)` : t`Endpoint`}
                <Input
                  id={`${ids}-endpoint`}
                  readOnly={Boolean(chosenNativeAccount)}
                  value={endpoint}
                  type="url"
                  onChange={(event) => {
                    setEndpoint(event.target.value);
                    setInputModalities([]);
                  }}
                  className="mt-1.5"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </label>
            ) : null}
            {harness === "claude" ? (
              <details className="mt-3 text-[13px] text-muted-foreground">
                <summary className="cursor-pointer">
                  <Trans>Advanced</Trans>
                </summary>
                <label htmlFor={`${ids}-auth`} className={fieldClass}>
                  <Trans>Authentication header</Trans>
                  <NativeSelect
                    id={`${ids}-auth`}
                    value={authScheme}
                    onChange={(event) => setAuthScheme(event.target.value as "api-key" | "bearer")}
                    className="mt-1.5 w-full"
                  >
                    <NativeSelectOption value="api-key">{t`API key`}</NativeSelectOption>
                    <NativeSelectOption value="bearer">{t`Bearer token`}</NativeSelectOption>
                  </NativeSelect>
                </label>
                {(["haiku", "sonnet", "opus", "fable", "subagent"] as const).map((role) => (
                  <label key={role} htmlFor={`${ids}-role-${role}`} className={fieldClass}>
                    {role}
                    <Input
                      id={`${ids}-role-${role}`}
                      aria-label={t`Model for ${role}`}
                      value={modelRoles[role] ?? ""}
                      placeholder={modelId}
                      onChange={(event) =>
                        setModelRoles((current) => ({
                          ...current,
                          [role]: event.target.value.trim() || undefined,
                        }))
                      }
                      className="mt-1.5"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </label>
                ))}
              </details>
            ) : null}
            {harness !== "pi" && modelId.trim()
              ? creatableInputs.map((kind) => (
                  <label
                    key={kind}
                    htmlFor={`${ids}-input-${kind}`}
                    className="mt-3 flex items-center justify-between gap-3 text-[13px]"
                  >
                    {kind === "image" ? t`Model accepts images` : t`Model accepts uploaded audio`}
                    <Switch
                      id={`${ids}-input-${kind}`}
                      aria-label={
                        kind === "image" ? t`Model accepts images` : t`Model accepts uploaded audio`
                      }
                      checked={inputModalities.includes(kind)}
                      onCheckedChange={(checked) =>
                        setInputModalities((current) =>
                          checked ? [...current, kind] : current.filter((entry) => entry !== kind),
                        )
                      }
                    />
                  </label>
                ))
              : null}
            <label className={fieldClass} htmlFor={`${ids}-environment`}>
              <Trans>Environment</Trans>
              <NativeSelect
                id={`${ids}-environment`}
                className="mt-1.5 w-full"
                value={computerId ?? ""}
                disabled={Boolean(chosenNativeAccount)}
                onChange={(event) => setComputerId(event.target.value || null)}
              >
                <NativeSelectOption value="">{t`Bot computer`}</NativeSelectOption>
                {computerId && !computers.some((computer) => computer.id === computerId) ? (
                  <NativeSelectOption value={computerId}>{t`Pinned computer`}</NativeSelectOption>
                ) : null}
                {computers.map((computer) => (
                  <NativeSelectOption key={computer.id} value={computer.id}>
                    {computerLabel(computer)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          </fieldset>
          {error ? (
            <p role="alert" className="mt-2 text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button disabled={!canCreate || pending} onClick={() => void createProfile()}>
              <Trans>Create profile</Trans>
            </Button>
            <Button variant="ghost" disabled={pending} onClick={resetForm}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
