import type {
  ModelAccountConfig,
  ModelAccountErrorCode,
  ModelAccountStatus,
} from "@rakazo/contracts";
import { modelAccountErrorCodeSchema } from "@rakazo/contracts";
import { ModelAccountClientError, resolveAccountNavigation } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Linking, View } from "react-native";
import { errorText } from "../lib/api/user-error";
import { continueWithSso } from "../lib/auth/sso";
import { modelAccountClient as client } from "../lib/model-account-client";
import { useI18n } from "../lib/model-account-i18n";
import { SettingsGroup, SettingsRow } from "./settings/settings-group";
import { MenuPickerMenu } from "./ui/menu-picker";

export function ModelAccount({
  onChanged,
  required = false,
}: {
  onChanged?: () => void | Promise<void>;
  required?: boolean;
}) {
  const { t } = useI18n();
  const [config, setConfig] = useState<ModelAccountConfig>();
  const [status, setStatus] = useState<ModelAccountStatus>();
  const [balance, setBalance] = useState<string>();
  const [error, setError] = useState<ModelAccountErrorCode>();
  const [identityError, setIdentityError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const actionAbort = useRef<AbortController | null>(null);
  const refresh = useCallback(
    async (api: ReturnType<typeof client>, signal?: AbortSignal, includeBalance = true) => {
      const latest = await api.status(signal);
      if (signal?.aborted) return;
      setStatus(latest);
      if (latest.linked) setIdentityError(undefined);
      if (latest.recovery !== "authorization_unknown" && latest.recovery !== "revocation_unknown")
        setError((previous) => (previous === "result_unknown" ? undefined : previous));
      if (latest.linked === false || !latest.connected || latest.recovery) {
        setBalance(undefined);
        return;
      }
      if (!includeBalance) return;
      try {
        const funds = await api.balance(signal);
        if (!signal?.aborted) setBalance(`${funds.amount} ${funds.unit}`);
      } catch {
        if (!signal?.aborted) setBalance(t("Balance unavailable"));
      }
    },
    [t],
  );
  useFocusEffect(
    useCallback(() => {
      const abort = new AbortController();
      setBusy(false);
      setConfig(undefined);
      setStatus(undefined);
      setBalance(undefined);
      setIdentityError(undefined);
      setError(undefined);
      const api = client();
      const update = () => {
        void api
          .config(abort.signal)
          .then(async (value) => {
            if (abort.signal.aborted) return;
            setConfig(value);
            if (value.enabled) await refresh(api, abort.signal);
          })
          .catch((cause) => {
            if (!abort.signal.aborted)
              setError(cause instanceof ModelAccountClientError ? cause.code : "unavailable");
          });
      };
      update();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") update();
      });
      return () => {
        abort.abort();
        actionAbort.current?.abort();
        subscription.remove();
      };
    }, [refresh, attempt]),
  );
  if (!config?.enabled)
    return required && (config || error) ? (
      <SettingsGroup label={t("Model account")}>
        <SettingsRow title={t("Model account unavailable")} />
      </SettingsGroup>
    ) : null;
  const navigation = resolveAccountNavigation(config);
  const serviceName = config.serviceName ?? t("model service");
  const authorizationTitle = config.serviceName
    ? t("Authorize access to {serviceName} models", { serviceName })
    : t("Authorize model service");
  const disclosure = t(
    "After authorization, this app will use your {serviceName} account to call models. Model usage is charged to your {serviceName} account balance.",
    { serviceName },
  );
  const act = async (
    kind: "connect" | "revoke" | "refresh" | "models" | "protocol" | "identity",
    protocol?: "chat-completions" | "responses",
  ) => {
    const abort = new AbortController();
    actionAbort.current = abort;
    setBusy(true);
    setError(undefined);
    setIdentityError(undefined);
    const api = client();
    try {
      if (kind === "identity") {
        if (!(await continueWithSso("link"))) return;
      } else if (kind === "protocol" && protocol) await api.settings(protocol, abort.signal);
      else if (kind === "models") await api.refreshModels(abort.signal);
      else if (kind === "revoke") await api.revoke(abort.signal);
      else if (kind !== "refresh") {
        const result = await api.connect(undefined, abort.signal);
        abort.signal.throwIfAborted();
        if (result.url) {
          const { openAuthSessionAsync } = await import("expo-web-browser");
          abort.signal.throwIfAborted();
          const authorization = await openAuthSessionAsync(
            result.url,
            "rakazo://model-authorization",
          );
          if (authorization.type === "success") {
            const code = modelAccountErrorCodeSchema.safeParse(
              new URL(authorization.url).searchParams.get("error"),
            );
            if (code.success) throw new ModelAccountClientError(code.data);
          }
        }
      }
      abort.signal.throwIfAborted();
      await refresh(api, abort.signal, kind === "refresh");
      await onChanged?.();
    } catch (cause) {
      if (abort.signal.aborted) return;
      if (kind === "identity") setIdentityError(errorText(cause, t("Could not continue")));
      setError(cause instanceof ModelAccountClientError ? cause.code : "unavailable");
      await refresh(api, abort.signal).catch(() => undefined);
    } finally {
      if (!abort.signal.aborted) setBusy(false);
      if (actionAbort.current === abort) actionAbort.current = null;
    }
  };
  const identityUnavailable = status?.linked === false || error === "link_required";
  const setup =
    !status?.connected ||
    Boolean(status.recovery) ||
    identityUnavailable ||
    error === "authorization_required";
  const message =
    identityError ??
    (status?.recovery === "revocation_unknown"
      ? t("Disconnection pending confirmation.")
      : error &&
          error !== "authorization_required" &&
          error !== "result_unknown" &&
          !identityUnavailable
        ? t("Model account unavailable")
        : error === "result_unknown" || status?.recovery === "authorization_unknown"
          ? t("Could not confirm authorization. Try again.")
          : error === "authorization_required" || status?.recovery === "authorization_required"
            ? t("Authorize the model account to continue.")
            : status?.recovery === "authorization_pending"
              ? t("Authorization incomplete.")
              : identityUnavailable
                ? t("Sign in with SSO to use the model account.")
                : error
                  ? t("Model account unavailable")
                  : undefined);

  if (!status)
    return (
      <SettingsGroup
        label={authorizationTitle}
        footer={error ? t("Model account unavailable") : undefined}
      >
        {error ? (
          <SettingsRow title={t("Retry")} onPress={() => setAttempt((value) => value + 1)} />
        ) : (
          <SettingsRow title={t("Checking authorization…")} trailing={<ActivityIndicator />} />
        )}
      </SettingsGroup>
    );
  return (
    <SettingsGroup
      label={setup ? authorizationTitle : t("Model account")}
      footer={
        setup
          ? [disclosure, message, t("You will return to the app after authorization.")]
              .filter(Boolean)
              .join("\n")
          : message
      }
    >
      {!setup && status?.connected && !message ? <SettingsRow title={t("Connected")} /> : null}
      {identityUnavailable ? (
        <SettingsRow
          title={t("Continue with {name}", { name: "SSO" })}
          disabled={busy}
          prominent
          trailing={busy ? <ActivityIndicator /> : undefined}
          onPress={() => void act("identity")}
        />
      ) : null}
      {!identityUnavailable &&
      status?.recovery !== "revocation_unknown" &&
      (!status?.connected ||
        error === "authorization_required" ||
        status?.recovery === "authorization_required" ||
        status?.recovery) ? (
        <SettingsRow
          title={
            busy
              ? t("Authorizing…")
              : error === "authorization_required" || status?.recovery === "authorization_required"
                ? t("Authorize again")
                : status?.recovery === "authorization_unknown" || error === "result_unknown"
                  ? t("Retry")
                  : status?.recovery === "authorization_pending"
                    ? t("Authorize again")
                    : t("Agree and authorize")
          }
          disabled={busy}
          prominent
          trailing={busy ? <ActivityIndicator /> : undefined}
          onPress={() =>
            void act(status?.recovery === "authorization_unknown" ? "refresh" : "connect")
          }
        />
      ) : null}
      {!setup && status?.connected ? (
        <SettingsRow
          title={t("Refresh models")}
          disabled={busy}
          onPress={() => void act("models")}
        />
      ) : null}
      {status?.recovery === "revocation_unknown" ? (
        <SettingsRow
          title={t("Retry disconnect")}
          destructive
          disabled={busy}
          onPress={() => void act("revoke")}
        />
      ) : null}
      {!setup && status?.connected ? (
        <MenuPickerMenu
          label={t("API protocol")}
          choices={[
            { key: "chat-completions", label: "Chat Completions" },
            { key: "responses", label: "Responses" },
          ]}
          value={status.apiProtocol ?? "chat-completions"}
          disabled={busy}
          onChange={(value) => {
            if (value === "responses" || value === "chat-completions") void act("protocol", value);
          }}
        >
          <View>
            <SettingsRow
              title={t("API protocol")}
              value={status.apiProtocol === "responses" ? "Responses" : "Chat Completions"}
              disabled={busy}
            />
          </View>
        </MenuPickerMenu>
      ) : null}
      {!setup ? (
        <SettingsRow
          title={t("Refresh balance")}
          value={balance}
          disabled={busy}
          onPress={() => void act("refresh")}
        />
      ) : null}
      {!setup && navigation ? (
        <>
          <SettingsRow
            title={t("Home")}
            onPress={() =>
              void Linking.openURL(navigation.homeUrl).catch(() =>
                Alert.alert(t("Could not continue")),
              )
            }
          />
          <SettingsRow
            title={t("Recharge")}
            onPress={() =>
              void Linking.openURL(navigation.rechargeUrl).catch(() =>
                Alert.alert(t("Could not continue")),
              )
            }
          />
        </>
      ) : null}
    </SettingsGroup>
  );
}
