import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AccountSecurity,
  BotAvatarSet,
  ChatPreferences,
  ChatPreferencesPatch,
  SignInProvider,
} from "@rakazo/contracts";
import {
  APP_LOCALE_LABELS,
  accountDisplay,
  displayName,
  localTimezone,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  sameTimeZone,
} from "@rakazo/core";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  Label,
  OptionSelect,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { AccountAccess, LinkSsoRow } from "../../components/account/AccountAccess";
import { PasskeySettings } from "../../components/account/PasskeySettings";
import { SuccessPop } from "../../components/ai/primitives";
import { ComputerProviderSettings } from "../../components/computers/ComputerProviderSettings";
import {
  ComputersUnavailableHint,
  computersAreUnavailable,
} from "../../components/computers/ComputersUnavailableHint";
import { DesktopUpdateSection } from "../../components/DesktopUpdates";
import { AccountDataSettings } from "../../components/settings/AccountDataSettings";
import { SettingsGroup, SettingsRow } from "../../components/settings/SettingsRows";
import { TrustedLinkSitesSettings } from "../../components/settings/TrustedLinkSitesSettings";
import { authClient } from "../../lib/auth/auth";
import { fetchAuthCapabilities } from "../../lib/auth/auth-capabilities";
import { usePasskeysSupported } from "../../lib/auth/passkeys";
import { toolActivityPreference } from "../../lib/chat/tool-activity-preference";
import { composerEnterToSendPreference } from "../../lib/composer/composer-enter-to-send-pref";
import { getActiveUiLocale, setUiLocale } from "../../lib/locale/i18n";
import { keepTimezone } from "../../lib/locale/kept-timezone";
import { timezoneOptions } from "../../lib/locale/local-timezone";
import type { UiLocale } from "../../lib/locale/ui-locale";
import { UI_LOCALES } from "../../lib/locale/ui-locale";
import type { BotsSidebarDensity } from "../../lib/preferences/bots-sidebar-density-pref";
import { botsSidebarDensityPreference } from "../../lib/preferences/bots-sidebar-density-pref";
import {
  chatPreferencesQuery,
  deviceChatPreferences,
  useChatPreferences,
} from "../../lib/preferences/chat-preferences";
import { remoteImagesPreference } from "../../lib/preferences/remote-images-preference";
import type { AppearancePreference } from "../../lib/preferences/ui-appearance";
import { getUiAppearancePreference, setUiAppearance } from "../../lib/preferences/ui-appearance";
import { useQueryUserId, useSave, useSpaceQueries } from "../../lib/query/query";
import type { RpcClient } from "../../lib/query/rpc";
import { authErrorText } from "../../lib/query/user-error";

export type SettingsGeneralProps = {
  email?: string | null;
  name: string;
  onNameSaved?: () => Promise<void>;
  /** The user's saved IANA timezone, or null before one is set. */
  timezone?: string | null;
  onTimezoneChange?: (timezone: string, client: RpcClient) => Promise<void>;
  /** The icon set new and unpinned bots wear; absent from servers that predate it. */
  botAvatarSet?: BotAvatarSet;
  onBotAvatarSetChange?: (set: BotAvatarSet) => Promise<void>;
  onAccountImported?: () => Promise<void>;
  onImportAgent?: () => void;
};

export function GeneralSettingsPanels({
  email,
  name,
  onNameSaved,
  timezone = null,
  onTimezoneChange,
  botAvatarSet,
  onBotAvatarSetChange,
  onAccountImported,
  onImportAgent,
}: SettingsGeneralProps) {
  const { t } = useLingui();
  const account = accountDisplay({ name, email }, t`You`);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const nameSave = useSave({
    save: async (nextName: string) => {
      const result = await authClient.updateUser({ name: nextName }).catch(() => {
        throw new Error(t`Could not update name`);
      });
      if (result.error) throw new Error(authErrorText(result.error, t`Could not update name`));
      // The shell shows the name too, so it refreshes even after this panel is gone.
      void Promise.resolve()
        .then(() => onNameSaved?.())
        .catch(() => undefined);
    },
    onSaved: () => setEditingName(false),
  });
  const namePending = nameSave.pending;
  const nameId = useId();
  const shownNameError = nameSave.error?.message ?? nameError;

  function saveName() {
    const nextName = nameDraft.trim();
    if (namePending || !nextName || nextName.length > 80) return;
    nameSave.reset();
    if (!displayName(nextName, "")) {
      setNameError(t`Could not update name`);
      return;
    }
    setNameError(null);
    // Nothing to save, so close without a request that could only fail.
    if (nextName === (account.label === email ? "" : displayName(name, ""))) {
      setEditingName(false);
      return;
    }
    nameSave.run(nextName);
  }

  const [accountSecurity, setAccountSecurity] = useState<AccountSecurity | null>(null);
  const [locale, setLocale] = useState<UiLocale>(() => getActiveUiLocale());
  const localeRequestRef = useRef(0);
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    getUiAppearancePreference(),
  );
  const sidebarDensity = botsSidebarDensityPreference.use();
  const sidebarDensityLabelId = useId();
  const botStyleLabelId = useId();
  const [botStyleError, setBotStyleError] = useState<string | null>(null);
  const streamRepliesId = useId();
  const showToolActivity = toolActivityPreference.use();
  const showToolActivityId = useId();
  const enterToSend = composerEnterToSendPreference.use();
  const enterToSendId = useId();
  const composerModelId = useId();
  const loadRemoteImages = remoteImagesPreference.use();
  const loadRemoteImagesId = useId();
  const timezoneId = useId();
  const showPassword = Boolean(
    accountSecurity?.hasPassword && accountSecurity.passwordChangeEnabled !== false,
  );
  const [providers, setProviders] = useState<SignInProvider[]>([]);
  const passkeysSupported = usePasskeysSupported();
  useEffect(() => {
    let active = true;
    void fetchAuthCapabilities()
      .then((value) => {
        if (active) setProviders(value.providers ?? []);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const unlinkedProviders = accountSecurity?.linkedProviderIds
    ? providers.filter(
        (provider) =>
          provider.id !== "oidc" && !accountSecurity.linkedProviderIds?.includes(provider.id),
      )
    : [];
  const canLinkSso = Boolean(accountSecurity?.sso && !accountSecurity.ssoLinked);
  const queries = useSpaceQueries();
  const queryUserId = useQueryUserId();
  const queryClient = useQueryClient();
  const meRead = chatPreferencesQuery(queries, queryUserId);
  const { data: me, isLoading: loadingAccount } = useQuery(meRead);
  const chat = useChatPreferences(me?.chatPreferences);
  const chatSave = useSave({
    save: async (chatPreferences: ChatPreferencesPatch, client) => {
      const saved = await client.preferences.update({ chatPreferences });
      queryClient.setQueryData(
        meRead.queryKey,
        (current) => current && { ...current, chatPreferences: saved.chatPreferences },
      );
    },
    stale: [meRead.queryKey],
  });
  const chatSaveDisabled = chatSave.pending || loadingAccount;

  function changeChatPreference(key: keyof ChatPreferences, value: boolean) {
    if (me?.chatPreferences) chatSave.run({ [key]: value });
    else deviceChatPreferences[key].set(value);
  }

  const deviceTimezone = localTimezone();
  const timezoneSave = useSave({
    save: async (next: string, client) => {
      await onTimezoneChange?.(next, client);
      // A zone picked by hand answers the device's prompt too, so it does not ask right after,
      // even when Settings closed while it saved.
      const device = localTimezone();
      if (queryUserId && !sameTimeZone(next, device))
        keepTimezone(queryUserId, { device, account: next });
    },
    // Usage is grouped by day in the account's timezone.
    stale: [queries.usage.breakdown.key()],
  });
  const timezonePending = timezoneSave.pending;
  const selectedTimezone = timezone ?? deviceTimezone;

  function chooseLocale(next: UiLocale) {
    if (next === locale) return;
    const requestId = ++localeRequestRef.current;
    setLocale(next);
    void setUiLocale(next).then((activated) => {
      if (requestId !== localeRequestRef.current) return;
      setLocale(activated);
    });
  }

  function chooseTimezone(next: string) {
    if (!onTimezoneChange || timezonePending || next === timezone) return;
    timezoneSave.run(next);
  }

  return (
    <div className="space-y-8">
      <SettingsGroup title={<Trans>Account</Trans>} data-testid="account-card">
        {editingName ? (
          <form
            className="space-y-3 px-4 py-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveName();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (!namePending) setEditingName(false);
              }
            }}
          >
            <Field>
              <FieldLabel htmlFor={nameId}>
                <Trans>Name</Trans>
              </FieldLabel>
              <Input
                id={nameId}
                autoComplete="name"
                autoFocus
                maxLength={80}
                value={nameDraft}
                disabled={namePending}
                onChange={(event) => {
                  setNameDraft(event.target.value);
                  setNameError(null);
                  nameSave.reset();
                }}
              />
            </Field>
            {shownNameError ? (
              <p role="alert" className="text-body-sm text-destructive">
                {shownNameError}
              </p>
            ) : null}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={namePending || !nameDraft.trim()}>
                <Trans>Save</Trans>
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={namePending}
                onClick={() => setEditingName(false)}
              >
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </form>
        ) : (
          <SettingsRow
            label={
              <>
                <p className="break-words">{account.label}</p>
                {email && account.label !== email ? (
                  <p className="mt-0.5 break-words text-body-sm text-muted-foreground">{email}</p>
                ) : null}
              </>
            }
            control={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setNameDraft(account.label === email ? "" : displayName(name, ""));
                  setNameError(null);
                  nameSave.reset();
                  setEditingName(true);
                }}
              >
                <Trans>Edit</Trans>
              </Button>
            }
          />
        )}
      </SettingsGroup>

      <SettingsGroup title={<Trans>Preferences</Trans>}>
        <SettingsRow
          label={<Trans>Appearance</Trans>}
          control={
            <AppearancePicker
              value={appearance}
              onChange={(next) => {
                setAppearance(next);
                setUiAppearance(next);
              }}
            />
          }
        />
        {onBotAvatarSetChange ? (
          <SettingsRow
            label={
              <span id={botStyleLabelId}>
                <Trans>Bot style</Trans>
              </span>
            }
            control={
              <div className="space-y-1">
                <ToggleGroup
                  aria-labelledby={botStyleLabelId}
                  data-testid="bot-style-select"
                  value={botAvatarSet ? [botAvatarSet] : []}
                  onValueChange={([next]) => {
                    if (!next || next === botAvatarSet) return;
                    setBotStyleError(null);
                    onBotAvatarSetChange(next as BotAvatarSet).catch(() =>
                      setBotStyleError(t`Couldn't update bot style`),
                    );
                  }}
                  spacing={1}
                  className="grid min-w-0 grid-cols-2 rounded-lg bg-muted p-1"
                >
                  <ToggleGroupItem
                    value="organic"
                    className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
                  >
                    <Trans>Original</Trans>
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="rakazo"
                    className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
                  >
                    <Trans>Rakazo</Trans>
                  </ToggleGroupItem>
                </ToggleGroup>
                {botStyleError ? (
                  <p role="alert" className="text-body-sm text-destructive">
                    {botStyleError}
                  </p>
                ) : null}
              </div>
            }
          />
        ) : null}
        <SettingsRow
          label={
            <span id={sidebarDensityLabelId}>
              <Trans>Sidebar density</Trans>
            </span>
          }
          control={
            <ToggleGroup
              aria-labelledby={sidebarDensityLabelId}
              data-testid="bots-sidebar-density-select"
              value={[sidebarDensity]}
              onValueChange={([next]) => {
                if (next) botsSidebarDensityPreference.set(next as BotsSidebarDensity);
              }}
              spacing={1}
              className="grid min-w-0 grid-cols-2 rounded-lg bg-muted p-1"
            >
              <ToggleGroupItem
                value="comfortable"
                data-testid="bots-sidebar-density-comfortable"
                className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
              >
                <Trans>Comfortable</Trans>
              </ToggleGroupItem>
              <ToggleGroupItem
                value="compact"
                data-testid="bots-sidebar-density-compact"
                className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
              >
                <Trans>Compact</Trans>
              </ToggleGroupItem>
            </ToggleGroup>
          }
        />
        <SettingsRow
          label={<Trans>Language</Trans>}
          control={<UiLocalePicker value={locale} onChange={chooseLocale} />}
        />
        {onTimezoneChange ? (
          <div data-testid="timezone-settings">
            <SettingsRow
              label={
                <span id={timezoneId}>
                  <Trans>Timezone</Trans>
                </span>
              }
              control={
                <OptionSelect
                  aria-labelledby={timezoneId}
                  data-testid="timezone-select"
                  value={selectedTimezone}
                  disabled={timezonePending}
                  options={timezoneOptions(selectedTimezone).map((zone) => ({
                    value: zone,
                    label: zone.replaceAll("_", " "),
                  }))}
                  onValueChange={(zone) => chooseTimezone(zone)}
                  className="w-56 max-w-full"
                />
              }
            >
              {!sameTimeZone(selectedTimezone, deviceTimezone) ? (
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-auto max-w-full py-1.5 text-left whitespace-normal"
                    disabled={timezonePending}
                    data-testid="timezone-use-device"
                    onClick={() => chooseTimezone(deviceTimezone)}
                  >
                    <Trans comment="Switches the saved timezone to this device's, e.g. 'Use Pacific/Auckland'">
                      Use {deviceTimezone.replaceAll("_", " ")}
                    </Trans>
                  </Button>
                </div>
              ) : null}
              {timezoneSave.error ? (
                <p role="alert" className="mt-2 text-right text-body-sm text-destructive">
                  {t`Couldn't update your timezone`}
                </p>
              ) : null}
            </SettingsRow>
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={<Trans>Chat</Trans>}>
        <SettingsRow
          label={
            <Label htmlFor={enterToSendId} className="text-body font-normal text-foreground">
              <Trans>Send with Enter</Trans>
            </Label>
          }
          control={
            <Switch
              id={enterToSendId}
              data-testid="composer-enter-to-send-toggle"
              checked={enterToSend}
              onCheckedChange={(checked) => composerEnterToSendPreference.set(checked)}
            />
          }
        />
        <SettingsRow
          label={
            <Label htmlFor={composerModelId} className="text-body font-normal text-foreground">
              <Trans>Model picker in chat</Trans>
            </Label>
          }
          control={
            <Switch
              id={composerModelId}
              data-testid="composer-model-picker-toggle"
              checked={chat.composerModelPicker}
              disabled={chatSaveDisabled}
              onCheckedChange={(checked) => changeChatPreference("composerModelPicker", checked)}
            />
          }
        />
        <SettingsRow
          label={
            <Label htmlFor={streamRepliesId} className="text-body font-normal text-foreground">
              <Trans>Stream replies</Trans>
            </Label>
          }
          control={
            <Switch
              id={streamRepliesId}
              data-testid="response-streaming-toggle"
              checked={chat.streamReplies}
              disabled={chatSaveDisabled}
              onCheckedChange={(checked) => changeChatPreference("streamReplies", checked)}
            />
          }
        />
        <SettingsRow
          label={
            <Label htmlFor={showToolActivityId} className="text-body font-normal text-foreground">
              <Trans>Show tool activity</Trans>
            </Label>
          }
          control={
            <Switch
              id={showToolActivityId}
              data-testid="tool-activity-toggle"
              checked={showToolActivity}
              onCheckedChange={(checked) => toolActivityPreference.set(checked)}
            />
          }
        />
        <SettingsRow
          label={
            <Label htmlFor={loadRemoteImagesId} className="text-body font-normal text-foreground">
              <Trans>Load web images automatically</Trans>
            </Label>
          }
          control={
            <Switch
              id={loadRemoteImagesId}
              data-testid="remote-images-toggle"
              checked={loadRemoteImages}
              onCheckedChange={(checked) => remoteImagesPreference.set(checked)}
            />
          }
        />
      </SettingsGroup>

      {chatSave.error ? (
        <p role="alert" className="text-body-sm text-destructive">{t`Could not save`}</p>
      ) : null}

      <TrustedLinkSitesSettings />

      {showPassword || canLinkSso || passkeysSupported || unlinkedProviders.length > 0 ? (
        <SettingsGroup title={<Trans>Security</Trans>}>
          {showPassword ? <ChangePasswordRow email={email} /> : null}
          {canLinkSso ? (
            <LinkSsoRow
              provider={
                accountSecurity?.sso ? { id: "oidc", name: accountSecurity.sso.name } : undefined
              }
              onSecurity={setAccountSecurity}
            />
          ) : null}
          {unlinkedProviders.map((provider) => (
            <LinkSsoRow key={provider.id} provider={provider} onSecurity={setAccountSecurity} />
          ))}
          <PasskeySettings />
        </SettingsGroup>
      ) : null}

      <SettingsGroup title={<Trans>Data</Trans>} data-testid="account-data">
        <AccountDataSettings onImported={onAccountImported} onImportAgent={onImportAgent} />
        <AccountAccess onSecurity={setAccountSecurity} />
      </SettingsGroup>
    </div>
  );
}

export function ComputerSettingsPanel({
  sandboxProvider,
  onSandboxProviderChange,
  onRecoveryDismissed,
  canConfigureComputers = false,
  computerSettingsEnabled = false,
}: {
  sandboxProvider?: string | null;
  onSandboxProviderChange?: (sandboxProvider: string) => void;
  onRecoveryDismissed?: () => void;
  canConfigureComputers?: boolean;
  computerSettingsEnabled?: boolean;
}) {
  // Once shown, the hint stays mounted so a successful check can show its confirmation.
  const unavailable = computersAreUnavailable(sandboxProvider);
  const [hintShown, setHintShown] = useState(unavailable);
  if (unavailable && !hintShown) setHintShown(true);
  return (
    <div
      data-testid="computers-setup-settings"
      className="rounded-xl border border-border px-4 py-4 [&>form:first-child]:mt-0"
    >
      {hintShown ? (
        <ComputersUnavailableHint
          className="text-body-sm leading-relaxed text-muted-foreground"
          sandboxProvider={sandboxProvider}
          onRecovered={onSandboxProviderChange}
          onRecoveryDismissed={onRecoveryDismissed}
        />
      ) : null}
      {/* The server decides what an account may change, including removing keys it saved. */}
      {computerSettingsEnabled && (canConfigureComputers || sandboxProvider) ? (
        <ComputerProviderSettings
          scope={canConfigureComputers ? "deployment" : "account"}
          onProviderChange={onSandboxProviderChange}
        />
      ) : null}
    </div>
  );
}

export function UpdatesSettingsPanel() {
  return (
    <div className="space-y-5">
      <DesktopUpdateSection />
    </div>
  );
}

function ChangePasswordRow({ email }: { email?: string | null }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saved, setSaved] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const change = useSave({
    save: async (passwords: { currentPassword: string; newPassword: string }) => {
      const result = await authClient
        .changePassword({ ...passwords, revokeOtherSessions: true })
        .catch(() => {
          throw new Error(t`Could not reach the server`);
        });
      if (result.error) throw new Error(authErrorText(result.error, t`Could not change password`));
    },
    onSaved: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setOpen(false);
      setSaved(true);
    },
  });
  const pending = change.pending;
  const error = change.error?.message ?? (mismatch ? t`Passwords do not match` : null);

  function changePassword() {
    if (pending) return;
    change.reset();
    if (newPassword !== confirmation) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setSaved(false);
    change.run({ currentPassword, newPassword });
  }

  function close() {
    setOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    setMismatch(false);
    change.reset();
  }

  return (
    <SettingsRow
      label={<Trans>Password</Trans>}
      control={
        open ? null : (
          <>
            {saved ? <SuccessPop label={t`Password updated`} /> : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSaved(false);
                setOpen(true);
              }}
            >
              <Trans>Change password</Trans>
            </Button>
          </>
        )
      }
    >
      {open ? (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            changePassword();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="grid gap-3">
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={email ?? ""}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
            />
            <SettingsPasswordInput
              label={t`Current password`}
              autoComplete="current-password"
              autoFocus
              value={currentPassword}
              onChange={setCurrentPassword}
            />
            <SettingsPasswordInput
              label={t`New password`}
              autoComplete="new-password"
              value={newPassword}
              onChange={setNewPassword}
            />
            <SettingsPasswordInput
              label={t`Confirm password`}
              autoComplete="new-password"
              value={confirmation}
              onChange={setConfirmation}
            />
          </div>
          {error ? (
            <p role="alert" className="mt-3 text-body-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex items-center gap-3">
            <Button type="submit" disabled={pending || !currentPassword || !newPassword}>
              {pending ? <Trans>Changing…</Trans> : <Trans>Save</Trans>}
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={close}>
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : null}
    </SettingsRow>
  );
}

function SettingsPasswordInput({
  label,
  autoComplete,
  autoFocus,
  value,
  onChange,
}: {
  label: string;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="password"
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        minLength={autoComplete === "new-password" ? MIN_PASSWORD_LENGTH : undefined}
        maxLength={MAX_PASSWORD_LENGTH}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function AppearancePicker({
  value,
  onChange,
}: {
  value: AppearancePreference;
  onChange: (next: AppearancePreference) => void;
}) {
  const { t } = useLingui();
  const options: { value: AppearancePreference; label: string }[] = [
    { value: "system", label: t`System` },
    { value: "light", label: t`Light` },
    { value: "dark", label: t`Dark` },
  ];

  return (
    <ToggleGroup
      aria-label={t`Appearance`}
      data-testid="ui-appearance-select"
      value={[value]}
      onValueChange={([next]) => {
        if (next) onChange(next as AppearancePreference);
      }}
      spacing={1}
      className="grid min-w-0 grid-cols-3 rounded-lg bg-muted p-1"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          data-testid={`ui-appearance-${option.value}`}
          className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function UiLocalePicker({
  value,
  onChange,
}: {
  value: UiLocale;
  onChange: (locale: UiLocale) => void;
}) {
  const { t } = useLingui();
  return (
    <OptionSelect
      className="w-56 max-w-full"
      data-testid="ui-locale-select"
      aria-label={t`Language`}
      options={UI_LOCALES.map((code) => ({
        value: code,
        label: APP_LOCALE_LABELS[code],
      }))}
      value={value}
      onValueChange={onChange}
    />
  );
}
