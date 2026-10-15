import type {
  ExecutionInputModality,
  ExecutionProfile,
  ExecutionProfileModel,
  ModelCredential,
  NativeLoginAccount,
  NativeLoginComputer,
  NativeLoginList,
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
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

type Harness = ExecutionProfile["harness"];
type Protocol = ExecutionProfile["protocol"];

export function ExecutionProfileSettings({
  value,
  currentProfile,
  onChange,
}: {
  value: string | null;
  currentProfile?: ExecutionProfile | null;
  onChange: (profileId: string | null) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setLoaded(false);
    setLoadError(false);
    void Promise.all([
      rpc<ExecutionProfile[]>("executionProfiles/list"),
      rpc<ModelCredential[]>("models/credentials"),
      rpc<NativeLoginList>("nativeLogins/list"),
    ])
      .then(([nextProfiles, nextCredentials, nativeLogins]) => {
        if (!current) return;
        setProfiles(nextProfiles);
        setCredentials(nextCredentials);
        setNativeAccounts(nativeLogins.accounts);
        setComputers(nativeLogins.computers);
        setLoaded(true);
      })
      .catch(() => {
        if (current) setLoadError(true);
      });
    return () => {
      current = false;
    };
  }, [refresh]);

  useEffect(() => {
    let current = true;
    setModelOptions([]);
    setModelsLoaded(false);
    setModelsError(false);
    if (!creating || !credentialId) return;
    void rpc<ExecutionProfileModel[]>("executionProfiles/models", { harness, credentialId })
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
  const inputLabels = { image: t("image input"), audio: t("uploaded audio") };
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
    return computer.scope === "team"
      ? t("Team computer")
      : computer.botName || t("Private computer");
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
  const canCreate = Boolean(
    loaded &&
      name.trim() &&
      runtimeVersion.trim() &&
      provider &&
      chosenAccount &&
      modelId.trim() &&
      (harness !== "pi" ||
        (modelsLoaded && (knownModel || (allowCustomModel && modelOptions.length > 0)))) &&
      (harness === "pi" || endpoint.trim()),
  );
  const choices = [
    { key: "", label: t("Pi (default)") },
    ...(value && !profiles.some((profile) => profile.id === value)
      ? [{ key: value, label: selected?.name ?? t("Unavailable profile") }]
      : []),
    ...profiles.map((profile) => ({
      key: profile.id,
      label: `${profile.name} · ${EXECUTION_HARNESS_LABELS[profile.harness]} · v${profile.revision}`,
    })),
  ];

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
      setError(parsed.error.issues[0]?.message ?? t("Check the profile fields"));
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const profile = await rpc<ExecutionProfile>("executionProfiles/create", parsed.data);
      if (!active.current) return;
      setProfiles((current) => [...current.filter((entry) => entry.id !== profile.id), profile]);
      onChange(profile.id);
      resetForm();
    } catch (err) {
      if (active.current) setError(errorText(err, t("Could not create profile")));
    } finally {
      pendingRef.current = false;
      if (active.current) setPending(false);
    }
  }

  const inputStyle = {
    color: tokens.foreground,
    borderColor: tokens.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    minHeight: 44,
    fontSize: 16,
  };
  const detailStyle = { color: tokens.mutedForeground, fontSize: 13, marginTop: 8 };
  function field(label: string, child: ReactNode) {
    return (
      <View style={{ gap: 6, marginTop: 12 }}>
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{label}</Text>
        {child}
      </View>
    );
  }

  return (
    <View testID="execution-profile-settings" style={{ marginTop: 8 }}>
      <View
        pointerEvents={pending ? "none" : "auto"}
        style={{ borderRadius: 14, backgroundColor: native.fill, overflow: "hidden" }}
      >
        <MenuPicker
          label={t("Execution profile")}
          choices={choices}
          value={value ?? ""}
          onChange={(key) => {
            if (!pendingRef.current) onChange(key || null);
          }}
        />
      </View>
      {loadError ? (
        <>
          <Text accessibilityRole="alert" style={{ ...detailStyle, color: tokens.destructive }}>
            {t("Could not load execution profiles")}
          </Text>
          <NativeActionButton
            label={t("Retry")}
            prominence="plain"
            onPress={() => setRefresh((value) => value + 1)}
          />
        </>
      ) : null}
      {selected ? (
        <View testID="execution-profile-effective">
          {[
            [
              t("Harness"),
              `${EXECUTION_HARNESS_LABELS[selected.harness]} · ${selected.runtimeVersion}`,
            ],
            [t("Provider"), selected.provider],
            [t("Protocol"), selected.protocol],
            [t("Model"), selected.modelId],
            [t("Account"), account?.label ?? (loaded ? t("Unavailable account") : t("Loading…"))],
            [t("Environment"), selected.computerId ? t("Pinned computer") : t("Bot computer")],
            ...(selected.endpoint ? [[t("Endpoint"), selected.endpoint]] : []),
          ].map(([label, detail]) => (
            <Text key={label} style={detailStyle}>
              {label}: {detail}
            </Text>
          ))}
          {unsupportedVersion ? (
            <Text accessibilityRole="alert" style={{ ...detailStyle, color: tokens.destructive }}>
              {t("Unsupported runtime version. Create a new revision.")}
            </Text>
          ) : null}
          <NativeActionButton
            label={t("New revision")}
            prominence="plain"
            disabled={!loaded || pending || creating}
            onPress={() => {
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
          />
          {selected.harness !== "pi" &&
          NATIVE_EXECUTION_CAPABILITIES.requiresRestrictedLinuxDocker ? (
            <Text style={detailStyle}>{t("Requires an enabled Linux Docker runtime.")}</Text>
          ) : null}
          {unsupportedInputs ? (
            <Text style={detailStyle}>
              {t("Unavailable: {capabilities}", { capabilities: unsupportedInputs })}
            </Text>
          ) : null}
          {undeclaredInputs ? (
            <Text style={detailStyle}>
              {t("Not enabled for this model: {capabilities}", { capabilities: undeclaredInputs })}
            </Text>
          ) : null}
          {nativeProfile && !nativeProfile.inputModalities?.includes("audio") ? (
            <Text style={detailStyle}>{t("Live calls use transcripts.")}</Text>
          ) : null}
          {selectedUsesNativeLogin ? (
            <Text style={detailStyle}>
              {t("Delegated agents are unavailable for signed-in accounts.")}{" "}
              {t("Group handoffs remain available.")}
            </Text>
          ) : null}
          {selected?.provider === "native-kimi" ? (
            <Text style={detailStyle}>{t("Personal interactive chats only.")}</Text>
          ) : null}
          {loaded && !account?.hasKey ? (
            <Text accessibilityRole="alert" style={{ ...detailStyle, color: tokens.destructive }}>
              {t("This profile’s account is unavailable. Choose another profile.")}
            </Text>
          ) : null}
        </View>
      ) : null}
      {value && !selected && loaded ? (
        <Text accessibilityRole="alert" style={{ ...detailStyle, color: tokens.destructive }}>
          {t("This profile is unavailable. Choose another profile.")}
        </Text>
      ) : null}
      {!creating ? (
        <NativeActionButton
          label={t("New profile")}
          prominence="plain"
          disabled={!loaded}
          onPress={() => setCreating(true)}
        />
      ) : (
        <View testID="execution-profile-create">
          <View pointerEvents={pending ? "none" : "auto"}>
            {field(
              t("Profile name"),
              <TextInput
                accessibilityLabel={t("Profile name")}
                style={inputStyle}
                value={name}
                maxLength={80}
                onChangeText={setName}
                editable={!pending}
              />,
            )}
            <MenuPicker
              label={t("Harness")}
              value={harness}
              choices={Object.entries(EXECUTION_HARNESS_LABELS).map(([key, label]) => ({
                key,
                label,
              }))}
              onChange={(key) => {
                const next = key as Harness;
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
            />
            {field(
              t("Runtime version"),
              <TextInput
                accessibilityLabel={t("Runtime version")}
                style={inputStyle}
                value={runtimeVersion}
                editable={false}
              />,
            )}
            <MenuPicker
              label={t("Provider")}
              value={provider}
              choices={[
                { key: "", label: t("Choose provider") },
                ...providers.map((key) => ({ key, label: key })),
              ]}
              onChange={(key) => {
                setProvider(key);
                setCredentialId("");
                setEndpoint("");
                setModelId("");
                setInputModalities([]);
              }}
            />
            {harness === "pi" ? (
              <Text style={detailStyle}>
                {t("Protocol")}: {protocol}
              </Text>
            ) : (
              <MenuPicker
                label={t("Protocol")}
                value={protocol}
                choices={EXECUTION_HARNESS_PROTOCOLS[harness].map((key) => ({ key, label: key }))}
                onChange={(key) => {
                  setProtocol(key as Protocol);
                  setCredentialId("");
                  setEndpoint("");
                  setModelId("");
                  setInputModalities([]);
                }}
              />
            )}
            <MenuPicker
              label={t("Account")}
              value={credentialId}
              choices={[
                { key: "", label: t("Choose account") },
                ...accounts.map((account) => ({ key: account.id, label: account.label })),
              ]}
              onChange={(key) => {
                const next = accounts.find((account) => account.id === key);
                setCredentialId(key);
                const signedIn = nativeAccounts.find((account) => account.credentialId === key);
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
            />
            {!availableCredentials.length ? (
              <Text style={detailStyle}>{t("Connect an account in Models first.")}</Text>
            ) : null}
            {modelOptions.length ? (
              <MenuPicker
                label={t("Model")}
                value={knownModel ? modelId : ""}
                choices={[
                  { key: "", label: allowCustomModel ? t("Other model…") : t("Choose model") },
                  ...modelOptions.map((entry) => ({ key: entry.id, label: entry.label })),
                ]}
                onChange={(key) => {
                  const next = modelOptions.find((entry) => entry.id === key);
                  setModelId(key);
                  if (harness === "pi" && next) setProtocol(next.protocol);
                  setInputModalities([]);
                }}
              />
            ) : null}
            {allowCustomModel && !knownModel
              ? field(
                  modelOptions.length ? t("Model id") : t("Model"),
                  <TextInput
                    accessibilityLabel={modelOptions.length ? t("Model id") : t("Model")}
                    style={inputStyle}
                    value={modelId}
                    onChangeText={(value) => {
                      setModelId(value);
                      setInputModalities([]);
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!pending}
                  />,
                )
              : null}
            {modelsError ? (
              <>
                <Text
                  accessibilityRole="alert"
                  style={{ ...detailStyle, color: tokens.destructive }}
                >
                  {t("Could not load models")}
                </Text>
                <NativeActionButton
                  label={t("Retry")}
                  prominence="plain"
                  onPress={() => setModelRefresh((value) => value + 1)}
                />
              </>
            ) : null}
            {harness === "pi" && credentialId && modelsLoaded && !modelOptions.length ? (
              <Text accessibilityRole="alert" style={{ ...detailStyle, color: tokens.destructive }}>
                {t("This account’s protocol is not supported by execution profiles.")}
              </Text>
            ) : null}
            {harness !== "pi" || provider === OPENAI_COMPATIBLE_PROVIDER_ID
              ? field(
                  harness === "pi" ? t("Endpoint (optional)") : t("Endpoint"),
                  <TextInput
                    accessibilityLabel={harness === "pi" ? t("Endpoint (optional)") : t("Endpoint")}
                    style={inputStyle}
                    value={endpoint}
                    onChangeText={(value) => {
                      setEndpoint(value);
                      setInputModalities([]);
                    }}
                    keyboardType="url"
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!pending && !chosenNativeAccount}
                  />,
                )
              : null}
            {harness === "claude" ? (
              <>
                <NativeActionButton
                  label={t("Advanced")}
                  prominence="plain"
                  onPress={() => setShowAdvanced((value) => !value)}
                />
                {showAdvanced ? (
                  <>
                    <MenuPicker
                      label={t("Authentication header")}
                      value={authScheme}
                      choices={[
                        { key: "api-key", label: t("API key") },
                        { key: "bearer", label: t("Bearer token") },
                      ]}
                      onChange={(value) => setAuthScheme(value as "api-key" | "bearer")}
                    />
                    {(["haiku", "sonnet", "opus", "fable", "subagent"] as const).map((role) => (
                      <View key={role}>
                        {field(
                          role,
                          <TextInput
                            accessibilityLabel={t("Model for {role}", { role })}
                            style={inputStyle}
                            value={modelRoles[role] ?? ""}
                            placeholder={modelId}
                            onChangeText={(value) =>
                              setModelRoles((current) => ({
                                ...current,
                                [role]: value.trim() || undefined,
                              }))
                            }
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!pending}
                          />,
                        )}
                      </View>
                    ))}
                  </>
                ) : null}
              </>
            ) : null}
            {harness !== "pi" && modelId.trim()
              ? creatableInputs.map((kind) => {
                  const label =
                    kind === "image"
                      ? t("Model accepts images")
                      : t("Model accepts uploaded audio");
                  return (
                    <View
                      key={kind}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                      }}
                    >
                      <Text style={{ ...detailStyle, flex: 1 }}>{label}</Text>
                      <NativeSwitch
                        accessibilityLabel={label}
                        value={inputModalities.includes(kind)}
                        disabled={pending}
                        onValueChange={(checked) =>
                          setInputModalities((current) =>
                            checked
                              ? [...current, kind]
                              : current.filter((entry) => entry !== kind),
                          )
                        }
                      />
                    </View>
                  );
                })
              : null}
            <View pointerEvents={chosenNativeAccount ? "none" : "auto"}>
              <MenuPicker
                label={t("Environment")}
                value={computerId ?? ""}
                choices={[
                  { key: "", label: t("Bot computer") },
                  ...(computerId && !computers.some((computer) => computer.id === computerId)
                    ? [{ key: computerId, label: t("Pinned computer") }]
                    : []),
                  ...computers.map((computer) => ({
                    key: computer.id,
                    label: computerLabel(computer),
                  })),
                ]}
                onChange={(key) => setComputerId(key || null)}
              />
            </View>
          </View>
          {error ? (
            <Text accessibilityRole="alert" style={{ ...detailStyle, color: tokens.destructive }}>
              {error}
            </Text>
          ) : null}
          <NativeActionButton
            label={t("Create profile")}
            disabled={!canCreate || pending}
            busy={pending}
            onPress={() => void createProfile()}
            style={{ marginTop: 16 }}
          />
          <NativeActionButton
            label={t("Cancel")}
            prominence="plain"
            disabled={pending}
            onPress={resetForm}
          />
        </View>
      )}
    </View>
  );
}
