import { Trans, useLingui } from "@lingui/react/macro";
import type { AvatarStyle } from "@rakazo/contracts";
import { BotAvatar } from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { BuiButton, SuccessPop } from "../components/beautiful-ui/primitives";
import {
  ComputersUnavailableHint,
  computersAreUnavailable,
} from "../components/ComputersUnavailableHint";
import { SoftwareUpdateSection } from "../components/SoftwareUpdateSection";
import { authClient } from "../lib/auth";
import { getActiveUiLocale, setUiLocale } from "../lib/i18n";
import {
  type AppearancePreference,
  getUiAppearancePreference,
  setUiAppearance,
} from "../lib/ui-appearance";
import { UI_LOCALE_LABELS, UI_LOCALES, type UiLocale } from "../lib/ui-locale";

export function AccountSettingsOverlay({
  email,
  name,
  usage,
  focusUsage,
  avatarStyle,
  onAvatarStyleChange,
  isDeploymentOwner = false,
  sandboxProvider,
  messagingEnabled = false,
  onOpenMessaging,
  onClose,
}: {
  email?: string | null;
  name: string;
  usage?: { runs: number; inputTokens: number; outputTokens: number } | null;
  focusUsage?: boolean;
  avatarStyle: AvatarStyle;
  onAvatarStyleChange: (style: AvatarStyle) => Promise<void>;
  isDeploymentOwner?: boolean;
  sandboxProvider?: string | null;
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const usageRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [locale, setLocale] = useState<UiLocale>(() => getActiveUiLocale());
  const localeRequestRef = useRef(0);
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    getUiAppearancePreference(),
  );
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const localeOpen = panelRef.current?.querySelector(
        '[data-testid="ui-locale-select"][aria-expanded="true"]',
      );
      if (localeOpen) return;
      onCloseRef.current();
    }
    window.addEventListener("keydown", handleKeyDown);
    if (focusUsage) usageRef.current?.focus();
    else panelRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [focusUsage]);

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

  return (
    <div className="absolute inset-0 z-30 overflow-hidden bg-[var(--rk-overlay)] p-4 sm:p-10">
      <div className="flex h-full min-h-0 items-center justify-center">
        <div
          ref={panelRef}
          data-testid="user-settings"
          role="dialog"
          aria-modal="true"
          aria-labelledby="account-settings-title"
          tabIndex={-1}
          className="rk-scroll max-h-full min-h-0 w-[640px] max-w-full overflow-y-auto overscroll-contain rounded-[26px] border border-[var(--rk-hairline-strong)] bg-[var(--rk-surface)] p-6 shadow-[0_40px_90px_rgba(0,0,0,.55)] sm:p-8"
        >
          <div className="flex items-start justify-between gap-6">
            <div>
              <h2
                id="account-settings-title"
                className="text-2xl font-medium text-[var(--rk-ink-strong)]"
              >
                <Trans>Settings</Trans>
              </h2>
            </div>
            <button
              type="button"
              aria-label={t`Close user settings`}
              onClick={onClose}
              className="text-[var(--rk-muted)]"
            >
              ✕
            </button>
          </div>

          <section className="mt-8 rounded-[14px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-4 py-4">
            <h3 className="text-[15px] font-medium text-[var(--rk-ink)]">
              <Trans>Account</Trans>
            </h3>
            <p className="mt-3 text-[14px] text-[var(--rk-soft)]">{name}</p>
            {email ? <p className="mt-1 text-[13px] text-[var(--rk-faint)]">{email}</p> : null}
          </section>

          <ChangePasswordSection />

          {messagingEnabled && onOpenMessaging ? (
            <section className="mt-5 rounded-[14px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-4 py-4">
              <h3 className="text-[15px] font-medium text-[var(--rk-ink)]">
                <Trans>Messaging</Trans>
              </h3>
              <p className="mt-3 text-[13px] text-[var(--rk-faint)]">
                <Trans>Chat apps, group channels, and agent connections.</Trans>
              </p>
              <button
                type="button"
                onClick={onOpenMessaging}
                className="mt-3 rounded-full bg-[var(--rk-border)] px-4 py-2 text-[13.5px] font-medium text-[var(--rk-ink)]"
              >
                <Trans>Manage messaging settings</Trans>
              </button>
            </section>
          ) : null}

          <section className="mt-5 rounded-[14px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-4 py-4">
            <h3 className="text-[15px] font-medium text-[var(--rk-ink)]">
              <Trans>Appearance</Trans>
            </h3>
            <AppearancePicker
              value={appearance}
              onChange={(next) => {
                setAppearance(next);
                setUiAppearance(next);
              }}
            />
          </section>

          <section className="mt-5 rounded-[14px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-4 py-4">
            <h3 className="text-[15px] font-medium text-[var(--rk-ink)]">
              <Trans>Language</Trans>
            </h3>
            <UiLocalePicker value={locale} onChange={chooseLocale} />
          </section>

          <section className="mt-5 rounded-[14px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-4 py-4">
            <h3 className="text-[15px] font-medium text-[var(--rk-ink)]">
              <Trans>Avatars</Trans>
            </h3>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {(["robot", "organic"] as const).map((style) => {
                const selected = style === avatarStyle;
                return (
                  <button
                    key={style}
                    type="button"
                    aria-pressed={selected}
                    disabled={avatarPending}
                    onClick={() => void chooseAvatarStyle(style)}
                    className={`flex items-center gap-3 rounded-[12px] border px-3.5 py-3 text-start text-[14px] text-[var(--rk-ink)] transition-colors disabled:opacity-50 ${
                      selected
                        ? "border-[var(--rk-border)] bg-[var(--rk-surface-2)]"
                        : "border-[var(--rk-border)] hover:border-[var(--rk-border)]"
                    }`}
                  >
                    <BotAvatar
                      color="#D9508A"
                      identity="avatar-style-preview"
                      size={32}
                      variant={style}
                    />
                    <span>{style === "robot" ? <Trans>Robot</Trans> : <Trans>Organic</Trans>}</span>
                  </button>
                );
              })}
            </div>
            {avatarError ? (
              <p role="alert" className="mt-3 text-[12.5px] text-[var(--rk-danger)]">
                {avatarError}
              </p>
            ) : null}
          </section>

          <div
            ref={usageRef}
            tabIndex={-1}
            data-testid="usage-settings"
            className="mt-5 rounded-[14px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-4 py-4 outline-none"
          >
            <h3 className="text-[15px] font-medium text-[var(--rk-ink)]">
              <Trans>Usage</Trans>
            </h3>
            {usage ? (
              <p className="mt-3 text-[14px] text-[var(--rk-soft)]">
                <Trans>
                  {usage.runs} runs · {usage.inputTokens + usage.outputTokens} tokens
                </Trans>
              </p>
            ) : null}
            <p className={`text-[12.5px] text-[var(--rk-muted-2)] ${usage ? "mt-2" : "mt-3"}`}>
              <Trans>Model spend uses your provider keys.</Trans>
            </p>
          </div>

          <SoftwareUpdateSection isDeploymentOwner={isDeploymentOwner} />

          {isDeploymentOwner && computersAreUnavailable(sandboxProvider) ? (
            <div
              data-testid="computers-setup-settings"
              className="mt-5 rounded-[14px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-4 py-4"
            >
              <h3 className="text-[15px] font-medium text-[var(--rk-ink)]">
                <Trans>Computers</Trans>
              </h3>
              <ComputersUnavailableHint className="mt-3 text-[13px] leading-relaxed text-[var(--rk-muted)]" />
            </div>
          ) : null}

          <details
            data-testid="advanced-settings"
            className="group mt-5 rounded-[14px] border border-[var(--rk-border)] bg-[var(--rk-inset)]"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 text-[14px] text-[var(--rk-soft)]">
              <span>
                <span className="block text-[15px] text-[var(--rk-ink)]">
                  <Trans>Advanced</Trans>
                </span>
                <span className="mt-1 block text-[12.5px] text-[var(--rk-muted-2)]">
                  <Trans>Optional controls most people never need</Trans>
                </span>
              </span>
              <span aria-hidden="true" className="transition-transform group-open:rotate-90">
                ›
              </span>
            </summary>
            <div className="border-t border-[var(--rk-hairline-strong)] px-4 pb-5">
              <ApprovalRulesSettings />
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

function ChangePasswordSection() {
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
        setError(result.error.message ?? t`Could not change password`);
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
    <section className="mt-5 rounded-[14px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-4 py-4">
      <h3 className="text-[15px] font-medium text-[var(--rk-ink)]">
        <Trans>Password</Trans>
      </h3>
      <div className="mt-3 grid gap-3">
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
        <p role="alert" className="mt-3 text-[12.5px] text-[var(--rk-danger)]">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex items-center gap-3">
        <BuiButton
          tone="accent"
          disabled={pending || currentPassword.length < 8 || newPassword.length < 8}
          onClick={() => void changePassword()}
        >
          {pending ? <Trans>Changing…</Trans> : <Trans>Change password</Trans>}
        </BuiButton>
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
  return (
    <label className="text-[12.5px] text-[var(--rk-muted)]">
      {label}
      <input
        aria-label={label}
        type="password"
        autoComplete={autoComplete}
        minLength={8}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 w-full rounded-[11px] border border-[var(--rk-scroll)] bg-[var(--rk-hairline)] px-3.5 py-2.5 text-[14px] text-[var(--rk-ink)] outline-none focus:border-[var(--rk-muted-2)]"
      />
    </label>
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
      className="mt-3 grid min-w-0 grid-cols-3 gap-1 rounded-[12px] border border-[var(--rk-border)] bg-[var(--rk-surface-2)] p-1"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            data-testid={`ui-appearance-${option.value}`}
            onClick={() => onChange(option.value)}
            className={`rounded-[9px] px-2 py-2 text-[13px] font-medium transition-colors ${
              selected
                ? "bg-[var(--rk-surface)] text-[var(--rk-ink-strong)] shadow-sm"
                : "text-[var(--rk-body)] hover:text-[var(--rk-ink-strong)]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
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
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(0, UI_LOCALES.indexOf(value));
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);

  useEffect(() => {
    setHighlightedIndex(selectedIndex);
    setOpen(false);
  }, [selectedIndex, value]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[highlightedIndex]?.focus();
  }, [highlightedIndex, open]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  function choose(index: number) {
    const next = UI_LOCALES[index];
    if (!next) return;
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveHighlight(index: number) {
    setHighlightedIndex((index + UI_LOCALES.length) % UI_LOCALES.length);
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex(UI_LOCALES.length - 1);
    }
  }

  function onOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setHighlightedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHighlightedIndex(UI_LOCALES.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(index);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div ref={rootRef} className="relative mt-3">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        data-testid="ui-locale-select"
        aria-label={t`Language`}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full items-center justify-between rounded-[11px] border border-[var(--rk-border)] bg-[var(--rk-inset)] px-3.5 py-3 text-start text-[var(--rk-ink)] outline-none focus-visible:border-[var(--rk-muted-2)]"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="min-w-0 truncate">{UI_LOCALE_LABELS[value]}</span>
        <span className="ml-3 shrink-0 text-[var(--rk-muted)]" aria-hidden="true">
          <ChevronDown size={16} strokeWidth={1.8} />
        </span>
      </button>
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t`Language`}
          className="rk-scroll absolute left-0 right-0 top-full z-20 mt-2 overflow-y-auto rounded-[11px] border border-[var(--rk-border)] bg-[var(--rk-inset)] p-1 shadow-[0_20px_45px_rgba(0,0,0,.55)]"
        >
          {UI_LOCALES.map((code, index) => (
            <button
              key={code}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="option"
              aria-selected={code === value}
              tabIndex={index === highlightedIndex ? 0 : -1}
              className={`w-full rounded-[8px] px-3 py-2 text-start text-[13.5px] text-[var(--rk-ink)] outline-none hover:bg-[var(--rk-surface-2)] focus-visible:bg-[var(--rk-surface-2)] ${
                code === value ? "bg-[var(--rk-surface-2)]" : ""
              }`}
              onClick={() => choose(index)}
              onKeyDown={(event) => onOptionKeyDown(event, index)}
            >
              {UI_LOCALE_LABELS[code]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
