import type { NativeLoginAccount, NativeLoginList } from "@rakazo/contracts";
import { EXECUTION_HARNESS_LABELS, isNativeLoginVerificationUri } from "@rakazo/contracts";
import { createNativeLoginMonitor } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import { Alert, Linking, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";
export function NativeLoginSettings() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<NativeLoginList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [harness, setHarness] = useState<"codex" | "kimi">("codex");
  const [label, setLabel] = useState("");
  const [computerId, setComputerId] = useState("");
  const [credentialId, setCredentialId] = useState<string>();
  const [region, setRegion] = useState<"global" | "mainland-cn">("global");
  const [attested, setAttested] = useState(false);
  const [pending, setPending] = useState(false);
  const active = useRef(true);
  const requestPending = useRef(false);
  const monitors = useRef(new Map<string, ReturnType<typeof createNativeLoginMonitor>>());
  function update(account: NativeLoginAccount) {
    if (!active.current) return;
    setData((current) =>
      current
        ? {
            ...current,
            accounts: [
              ...current.accounts.filter((entry) => entry.credentialId !== account.credentialId),
              account,
            ],
          }
        : current,
    );
  }
  function watch(account: NativeLoginAccount) {
    monitors.current.get(account.credentialId)?.stop();
    const monitor = createNativeLoginMonitor({
      status: (credentialId) => rpc<NativeLoginAccount>("nativeLogins/status", { credentialId }),
      onUpdate: update,
      onError: () => {
        if (active.current) setError(t("Could not check sign-in. Try reconnecting."));
      },
    });
    monitors.current.set(account.credentialId, monitor);
    monitor.start(account);
  }
  useEffect(() => {
    active.current = true;
    void rpc<NativeLoginList>("nativeLogins/list")
      .then((result) => {
        if (!active.current) return;
        setData(result);
        if (result.computers.length === 1) setComputerId(result.computers[0]!.id);
        for (const account of result.accounts) watch(account);
      })
      .catch(() => {
        if (active.current) setError(t("Could not load signed-in accounts"));
      });
    return () => {
      active.current = false;
      for (const monitor of monitors.current.values()) monitor.stop();
    };
  }, []);
  async function begin() {
    if (!attested || !label.trim() || !computerId || requestPending.current) return;
    requestPending.current = true;
    setPending(true);
    setError(null);
    try {
      const account = await rpc<NativeLoginAccount>("nativeLogins/begin", {
        harness,
        computerId,
        label: label.trim(),
        region,
        ...(credentialId ? { credentialId } : {}),
        selfHostedPersonalUse: true,
      });
      if (!active.current) return;
      update(account);
      watch(account);
      setEditing(false);
      setAttested(false);
    } catch (err) {
      if (active.current) setError(errorText(err, t("Could not start sign-in")));
    } finally {
      requestPending.current = false;
      if (active.current) setPending(false);
    }
  }
  async function end(account: NativeLoginAccount, action: "cancel" | "logout") {
    if (requestPending.current) return;
    monitors.current.get(account.credentialId)?.stop();
    requestPending.current = true;
    setPending(true);
    setError(null);
    try {
      update(
        await rpc<NativeLoginAccount>(`nativeLogins/${action}`, {
          credentialId: account.credentialId,
        }),
      );
    } catch (err) {
      if (active.current) setError(errorText(err, t("Could not disconnect account")));
    } finally {
      requestPending.current = false;
      if (active.current) {
        setPending(false);
      }
    }
  }
  function confirmLogout(account: NativeLoginAccount) {
    Alert.alert(
      t("Disconnect {name}?", { name: account.label }),
      t("Removes this sign-in from Rakazo. Provider sessions may remain active."),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Disconnect"), style: "destructive", onPress: () => void end(account, "logout") },
      ],
    );
  }
  function edit(account?: NativeLoginAccount) {
    setHarness(account?.harness ?? "codex");
    setLabel(account?.label ?? "");
    setCredentialId(account?.credentialId);
    setComputerId(
      account?.computerId ?? (data?.computers.length === 1 ? data.computers[0]!.id : ""),
    );
    setRegion(account?.endpoint.includes("api.kimi.com") ? "mainland-cn" : "global");
    setAttested(false);
    setEditing(true);
    setError(null);
  }
  if (!data)
    return error ? (
      <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
        {error}
      </Text>
    ) : null;
  if (!data.enabled && !data.accounts.length) return null;
  const textStyle = { color: tokens.mutedForeground, fontSize: 13, marginTop: 8 };
  const inputStyle = {
    color: tokens.foreground,
    borderColor: tokens.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    minHeight: 44,
    fontSize: 16,
  };
  return (
    <View testID="native-login-settings" style={{ marginTop: 20 }}>
      <NativeActionButton
        label={t("Native sign-in")}
        prominence="plain"
        onPress={() => setOpen((value) => !value)}
      />
      {open ? (
        <>
          {data.accounts.map((account) => (
            <View key={account.credentialId} style={{ marginTop: 16 }}>
              <Text style={{ color: tokens.foreground, fontSize: 15 }}>
                {account.label} · {EXECUTION_HARNESS_LABELS[account.harness]}
              </Text>
              {account.state.state === "pending" ? (
                <>
                  <Text style={textStyle}>{t("Finish signing in in your browser:")}</Text>
                  <NativeActionButton
                    label={t("Open sign-in page")}
                    disabled={
                      !isNativeLoginVerificationUri(account.harness, account.state.verificationUri)
                    }
                    prominence="plain"
                    onPress={() => {
                      if (
                        account.state.state === "pending" &&
                        isNativeLoginVerificationUri(account.harness, account.state.verificationUri)
                      )
                        void Linking.openURL(account.state.verificationUri).catch(() =>
                          setError(t("Could not open sign-in page")),
                        );
                    }}
                  />
                  <Text
                    selectable
                    accessibilityLabel={t("Verification code")}
                    style={{ ...textStyle, fontSize: 18 }}
                  >
                    {account.state.userCode}
                  </Text>
                  <NativeActionButton
                    label={t("Cancel sign-in")}
                    prominence="plain"
                    disabled={pending}
                    onPress={() => void end(account, "cancel")}
                  />
                </>
              ) : account.state.state === "ready" ? (
                <>
                  <Text style={textStyle}>
                    {account.state.accountLabel ?? t("Connected")}
                    {account.state.plan ? ` · ${account.state.plan}` : ""}
                  </Text>
                  <NativeActionButton
                    label={t("Disconnect")}
                    prominence="plain"
                    disabled={pending}
                    onPress={() => confirmLogout(account)}
                  />
                </>
              ) : (
                <>
                  <Text style={textStyle}>
                    {account.state.state === "signed_out"
                      ? t("Signed out")
                      : account.state.code === "expired"
                        ? t("Sign-in expired")
                        : t("Sign-in did not complete")}
                  </Text>
                  <NativeActionButton
                    label={t("Reconnect")}
                    prominence="plain"
                    disabled={pending || !data.enabled}
                    onPress={() => edit(account)}
                  />
                  {account.state.state === "failed" ? (
                    <NativeActionButton
                      label={t("Disconnect")}
                      prominence="plain"
                      disabled={pending}
                      onPress={() => confirmLogout(account)}
                    />
                  ) : null}
                </>
              )}
            </View>
          ))}
          {data.enabled && !editing ? (
            <NativeActionButton
              label={t("Add signed-in account")}
              prominence="plain"
              disabled={pending}
              onPress={() => edit()}
            />
          ) : data.enabled ? (
            <View pointerEvents={pending ? "none" : "auto"} style={{ marginTop: 16, gap: 12 }}>
              <View pointerEvents={credentialId ? "none" : "auto"}>
                <MenuPicker
                  label={t("Harness")}
                  value={harness}
                  choices={[
                    { key: "codex", label: "Codex" },
                    { key: "kimi", label: "Kimi Code" },
                  ]}
                  onChange={(key) => setHarness(key as "codex" | "kimi")}
                />
              </View>
              <Text style={textStyle}>{t("Account name")}</Text>
              <TextInput
                accessibilityLabel={t("Account name")}
                value={label}
                maxLength={80}
                onChangeText={setLabel}
                editable={!pending}
                style={inputStyle}
              />
              <MenuPicker
                label={t("Computer")}
                value={computerId}
                choices={[
                  { key: "", label: t("Choose computer") },
                  ...data.computers.map((computer) => ({
                    key: computer.id,
                    label:
                      computer.scope === "team"
                        ? t("Team computer")
                        : (computer.botName ?? t("Private computer")),
                  })),
                ]}
                onChange={setComputerId}
              />
              {!data.computers.length ? (
                <Text style={textStyle}>
                  {t("An available Linux Docker computer is required.")}
                </Text>
              ) : null}
              {harness === "kimi" ? (
                <>
                  <MenuPicker
                    label={t("Region")}
                    value={region}
                    choices={[
                      { key: "global", label: t("Global") },
                      { key: "mainland-cn", label: t("Mainland China") },
                    ]}
                    onChange={(key) => setRegion(key as "global" | "mainland-cn")}
                  />
                  <Text style={textStyle}>{t("Personal interactive chats only.")}</Text>
                </>
              ) : null}
              <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                <Text style={{ ...textStyle, flex: 1 }}>
                  {t("This is my personal, self-hosted deployment.")}
                </Text>
                <NativeSwitch
                  accessibilityLabel={t("This is my personal, self-hosted deployment.")}
                  value={attested}
                  onValueChange={setAttested}
                  disabled={pending}
                />
              </View>
              <NativeActionButton
                label={t("Sign in")}
                disabled={!attested || !computerId || !label.trim() || pending}
                onPress={() => void begin()}
              />
              <NativeActionButton
                label={t("Cancel")}
                prominence="plain"
                disabled={pending}
                onPress={() => setEditing(false)}
              />
            </View>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={{ ...textStyle, color: tokens.destructive }}>
              {error}
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
