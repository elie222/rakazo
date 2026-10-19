import { Trans, useLingui } from "@lingui/react/macro";
import type { AccountSecurity, AvatarStyle } from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  Field,
  FieldLabel,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Toggle,
} from "@rakazo/ui-web";
import type { RefObject } from "react";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { AccountAccess } from "../components/AccountAccess";
import { SuccessPop } from "../components/ai/primitives";
import { ComputersUnavailableHint } from "../components/ComputersUnavailableHint";
import { DesktopUpdateSection } from "../components/DesktopUpdates";
import { ListboxSelect } from "../components/ListboxSelect";
import { SoftwareUpdateSection } from "../components/SoftwareUpdateSection";
import { authClient } from "../lib/auth";
import {
  getBotsSidebarDensity,
  setBotsSidebarDensity,
  subscribeBotsSidebarDensity,
} from "../lib/bots-sidebar-density-pref";
import {
  getComposerEnterToSend,
  setComposerEnterToSend,
  subscribeComposerEnterToSend,
} from "../lib/composer-enter-to-send-pref";
import { getActiveUiLocale, setUiLocale } from "../lib/i18n";
import { localTimezone, sameTimeZone, timezoneOptions } from "../lib/local-timezone";
import {
  getRemoteImagesPreference,
  setRemoteImagesPreference,
} from "../lib/remote-images-preference";
import {
  getResponseStreamingPreference,
  setResponseStreamingPreference,
} from "../lib/response-streaming";
import {
  getToolActivityPreference,
  setToolActivityPreference,
} from "../lib/tool-activity-preference";
import type { AppearancePreference } from "../lib/ui-appearance";
import { getUiAppearancePreference, setUiAppearance } from "../lib/ui-appearance";
import type { UiLocale } from "../lib/ui-locale";
import { UI_LOCALE_LABELS, UI_LOCALES } from "../lib/ui-locale";
import { authErrorText } from "../lib/user-error";

export type SettingsGeneralProps = {
  email?: string | null;
  name: string;
  avatarStyle: AvatarStyle;
  onAvatarStyleChange: (style: AvatarStyle) => Promise<void>;
  /** The user's saved IANA timezone, or null before one is set. */
  timezone?: string | null;
  onTimezoneChange?: (timezone: string) => Promise<void>;
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
  isDeploymentOwner?: boolean;
};

export function GeneralSettingsPanels({
  email,
  name,
  avatarStyle,
  onAvatarStyleChange,
  timezone = null,
  onTimezoneChange,
  messagingEnabled = false,
  onOpenMessaging,
  isDeploymentOwner = false,
}: SettingsGeneralProps) {
  const { t } = useLingui();
  const [accountSecurity, setAccountSecurity] = useState<AccountSecurity | null>(null);
  const [locale, setLocale] = useState<UiLocale>(() => getActiveUiLocale());
  const localeRequestRef = useRef(0);
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    getUiAppearancePreference(),
  );
  const sidebarDensity = useSyncExternalStore(
    subscribeBotsSidebarDensity,
    getBotsSidebarDensity,
    () => "comfortable",
  );
  const sidebarDensityLabelId = useId();
  const [streamReplies, setStreamReplies] = useState(
    () => getResponseStreamingPreference() === "on",
  );
  const streamRepliesId = useId();
  const [showToolActivity, setShowToolActivity] = useState(
    () => getToolActivityPreference() === "on",
  );
  const showToolActivityId = useId();
  const enterToSend = useSyncExternalStore(
    subscribeComposerEnterToSend,
    getComposerEnterToSend,
    () => false,
  );
  const enterToSendId = useId();
  const [loadRemoteImages, setLoadRemoteImages] = useState(
    () => getRemoteImagesPreference() === "on",
  );
  const loadRemoteImagesId = useId();
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const timezoneId = useId();
  const [timezonePending, setTimezonePending] = useState(false);
  const [timezoneError, setTimezoneError] = useState<string | null>(null);
  const deviceTimezone = localTimezone();

  function chooseLocale(next: UiLocale) {
    if (next === locale) return;
    const requestId = ++localeRequestRef.current;
    setLocale(next);
    void setUiLocale(next).then((activated) => {
      if (requestId !== localeRequestRef.current) return;
      setLocale(activated);
    });
  }

  async function chooseAvatarStyle(next: AvatarStyle) {
    if (avatarPending || next === avatarStyle) return;
    setAvatarPending(true);
    setAvatarError(null);
    try {
      await onAvatarStyleChange(next);
    } catch {
      setAvatarError(t`Couldn't update avatars`);
    } finally {
      setAvatarPending(false);
    }
  }

  async function chooseTimezone(next: string) {
    if (!onTimezoneChange || timezonePending || next === timezone) return;
    setTimezonePending(true);
    setTimezoneError(null);
    try {
      await onTimezoneChange(next);
    } catch {
      setTimezoneError(t`Couldn't update your timezone`);
    } finally {
      setTimezonePending(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-border px-4 py-4">
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Account</Trans>
        </h3>
        <p className="mt-3 text-[14px] text-foreground/75">{name}</p>
        {email ? <p className="mt-1 text-[13px] text-muted-foreground/70">{email}</p> : null}
        <AccountAccess onSecurity={setAccountSecurity} />
      </section>

      {accountSecurity?.hasPassword && accountSecurity.passwordChangeEnabled !== false ? (
        <ChangePasswordSection email={email} />
      ) : null}

      {messagingEnabled && onOpenMessaging ? (
        <section className="rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Messaging</Trans>
          </h3>
          <Button variant="secondary" className="mt-3 rounded-full" onClick={onOpenMessaging}>
            <Trans>Manage messaging settings</Trans>
          </Button>
        </section>
      ) : null}

      <section className="rounded-xl border border-border px-4 py-4">
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Appearance</Trans>
        </h3>
        <AppearancePicker
          value={appearance}
          onChange={(next) => {
            setAppearance(next);
            setUiAppearance(next);
          }}
        />
        <div className="mt-4 flex items-center justify-between gap-3">
          <span id={sidebarDensityLabelId} className="text-[13px] text-foreground/75">
            <Trans>Sidebar density</Trans>
          </span>
          <fieldset
            aria-labelledby={sidebarDensityLabelId}
            data-testid="bots-sidebar-density-select"
            className="grid min-w-0 grid-cols-2 gap-1 rounded-lg bg-muted p-1"
          >
            <Toggle
              data-testid="bots-sidebar-density-comfortable"
              pressed={sidebarDensity === "comfortable"}
              onPressedChange={() => setBotsSidebarDensity("comfortable")}
              className="text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
            >
              <Trans>Comfortable</Trans>
            </Toggle>
            <Toggle
              data-testid="bots-sidebar-density-compact"
              pressed={sidebarDensity === "compact"}
              onPressedChange={() => setBotsSidebarDensity("compact")}
              className="text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
            >
              <Trans>Compact</Trans>
            </Toggle>
          </fieldset>
        </div>
      </section>

      <section className="rounded-xl border border-border px-4 py-4">
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Language</Trans>
        </h3>
        <UiLocalePicker value={locale} onChange={chooseLocale} />
      </section>

      {onTimezoneChange ? (
        <section
          className="rounded-xl border border-border px-4 py-4"
          data-testid="timezone-settings"
        >
          <h3 id={timezoneId} className="text-[15px] font-medium text-foreground">
            <Trans>Timezone</Trans>
          </h3>
          <NativeSelect
            aria-labelledby={timezoneId}
            data-testid="timezone-select"
            value={timezone ?? deviceTimezone}
            disabled={timezonePending}
            onChange={(event) => void chooseTimezone(event.target.value)}
            className="mt-3 w-full"
          >
            {timezoneOptions(timezone ?? deviceTimezone).map((zone) => (
              <NativeSelectOption key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {!timezone || !sameTimeZone(timezone, deviceTimezone) ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 h-auto max-w-full py-1.5 text-left whitespace-normal"
              disabled={timezonePending}
              data-testid="timezone-use-device"
              onClick={() => void chooseTimezone(deviceTimezone)}
            >
              <Trans comment="Switches the saved timezone to this device's, e.g. 'Use Pacific/Auckland'">
                Use {deviceTimezone.replaceAll("_", " ")}
              </Trans>
            </Button>
          ) : null}
          {timezoneError ? (
            <p role="alert" className="mt-3 text-[12.5px] text-destructive">
              {timezoneError}
            </p>
          ) : null}
        </section>
      ) : null}

      <section
        className="rounded-xl border border-border px-4 py-4"
        data-testid="avatar-style-select"
      >
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Avatars</Trans>
        </h3>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {(["robot", "organic"] as const).map((style) => (
            <Toggle
              key={style}
              variant="outline"
              pressed={style === avatarStyle}
              disabled={avatarPending}
              onPressedChange={() => void chooseAvatarStyle(style)}
              data-testid={`avatar-style-${style}`}
              className="h-auto justify-start gap-3 px-3.5 py-3 text-[14px] font-normal"
            >
              <BotAvatar
                color="#D9508A"
                identity="avatar-style-preview"
                size={32}
                variant={style}
              />
              <span>{style === "robot" ? <Trans>Robot</Trans> : <Trans>Organic</Trans>}</span>
            </Toggle>
          ))}
        </div>
        {avatarError ? (
          <p role="alert" className="mt-3 text-[12.5px] text-destructive">
            {avatarError}
          </p>
        ) : null}
      </section>

      {isDeploymentOwner ? (
        <Button variant="outline" render={<Link to="/integrations/setup" />}>
          <Trans>Server integrations</Trans>
        </Button>
      ) : null}

      <details data-testid="advanced-settings" className="group rounded-xl border border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 text-[14px] text-foreground/75">
          <span className="block text-[15px] text-foreground">
            <Trans>Advanced</Trans>
          </span>
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="border-t border-border px-4 pb-5">
          <div className="flex items-start gap-3 pt-5">
            <Switch
              id={enterToSendId}
              data-testid="composer-enter-to-send-toggle"
              className="mt-0.5"
              checked={enterToSend}
              onCheckedChange={(checked) => setComposerEnterToSend(checked)}
            />
            <Label htmlFor={enterToSendId} className="text-[14px] font-normal text-foreground/75">
              <Trans>Send with Enter</Trans>
            </Label>
          </div>
          <div className="flex items-start gap-3 pt-5">
            <Switch
              id={streamRepliesId}
              data-testid="response-streaming-toggle"
              className="mt-0.5"
              checked={streamReplies}
              onCheckedChange={(checked) => {
                setStreamReplies(checked);
                setResponseStreamingPreference(checked ? "on" : "off");
              }}
            />
            <Label htmlFor={streamRepliesId} className="text-[14px] font-normal text-foreground/75">
              <Trans>Stream replies</Trans>
            </Label>
          </div>
          <div className="flex items-start gap-3 pt-4">
            <Switch
              id={showToolActivityId}
              data-testid="tool-activity-toggle"
              className="mt-0.5"
              checked={showToolActivity}
              onCheckedChange={(checked) => {
                setShowToolActivity(checked);
                setToolActivityPreference(checked ? "on" : "off");
              }}
            />
            <Label
              htmlFor={showToolActivityId}
              className="text-[14px] font-normal text-foreground/75"
            >
              <Trans>Show tool activity</Trans>
            </Label>
          </div>
          <div className="flex items-start gap-3 pt-4">
            <Switch
              id={loadRemoteImagesId}
              data-testid="remote-images-toggle"
              className="mt-0.5"
              checked={loadRemoteImages}
              onCheckedChange={(checked) => {
                setLoadRemoteImages(checked);
                setRemoteImagesPreference(checked ? "on" : "off");
              }}
            />
            <Label
              htmlFor={loadRemoteImagesId}
              className="text-[14px] font-normal text-foreground/75"
            >
              <Trans>Load web images automatically</Trans>
            </Label>
          </div>
        </div>
      </details>
    </div>
  );
}

export function UsageSettingsPanel({
  usage,
  panelRef,
}: {
  usage?: {
    runs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens?: number | null;
  } | null;
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-testid="usage-settings"
      className="rounded-xl border border-border px-4 py-4 outline-none"
    >
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Usage</Trans>
      </h3>
      {usage ? (
        <p className="mt-3 text-[14px] text-foreground/75">
          <Trans>
            {usage.runs} runs · {usage.totalTokens ?? "—"} tokens
          </Trans>
        </p>
      ) : null}
      <p className={`text-[12.5px] text-muted-foreground/80 ${usage ? "mt-2" : "mt-3"}`}>
        <Trans>Model spend uses your provider keys.</Trans>
      </p>
    </div>
  );
}

export function ComputerSettingsPanel({
  sandboxProvider,
  onSandboxProviderChange,
  onRecoveryDismissed,
}: {
  sandboxProvider?: string | null;
  onSandboxProviderChange?: (sandboxProvider: string) => void;
  onRecoveryDismissed?: () => void;
}) {
  return (
    <div
      data-testid="computers-setup-settings"
      className="rounded-xl border border-border px-4 py-4"
    >
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Computers</Trans>
      </h3>
      <ComputersUnavailableHint
        className="mt-3 text-[13px] leading-relaxed text-muted-foreground"
        sandboxProvider={sandboxProvider}
        onRecovered={onSandboxProviderChange}
        onRecoveryDismissed={onRecoveryDismissed}
      />
    </div>
  );
}

export function UpdatesSettingsPanel({
  isDeploymentOwner = false,
}: {
  isDeploymentOwner?: boolean;
}) {
  return (
    <div className="space-y-5">
      <DesktopUpdateSection />
      <SoftwareUpdateSection isDeploymentOwner={isDeploymentOwner} />
    </div>
  );
}

function ChangePasswordSection({ email }: { email?: string | null }) {
  const { t } = useLingui();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changePassword() {
    if (pending) return;
    if (newPassword !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not change password`));
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setSaved(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-xl border border-border px-4 py-4">
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Password</Trans>
      </h3>
      <div className="mt-3 grid gap-3">
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
        <p role="alert" className="mt-3 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex items-center gap-3">
        <Button
          className="rounded-full"
          disabled={pending || currentPassword.length < 8 || newPassword.length < 8}
          onClick={() => void changePassword()}
        >
          {pending ? <Trans>Changing…</Trans> : <Trans>Change password</Trans>}
        </Button>
        {saved ? <SuccessPop label={t`Password updated`} /> : null}
      </div>
    </section>
  );
}

function SettingsPasswordInput({
  label,
  autoComplete,
  value,
  onChange,
}: {
  label: string;
  autoComplete: "current-password" | "new-password";
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
        minLength={8}
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
    <fieldset
      aria-label={t`Appearance`}
      data-testid="ui-appearance-select"
      className="mt-3 grid min-w-0 grid-cols-3 gap-1 rounded-lg bg-muted p-1"
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          data-testid={`ui-appearance-${option.value}`}
          pressed={option.value === value}
          onPressedChange={() => onChange(option.value)}
          className="text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm"
        >
          {option.label}
        </Toggle>
      ))}
    </fieldset>
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
    <ListboxSelect
      className="mt-3"
      testId="ui-locale-select"
      label={t`Language`}
      options={UI_LOCALES.map((code) => ({ value: code, label: UI_LOCALE_LABELS[code] }))}
      value={value}
      onChange={onChange}
    />
  );
}
