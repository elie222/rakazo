import { Trans, useLingui } from "@lingui/react/macro";
import type { AvatarStyle } from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Toggle,
} from "@rakazo/ui-web";
import { ChevronDown, XIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { SuccessPop } from "../components/ai/primitives";
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
  const [locale, setLocale] = useState<UiLocale>(() => getActiveUiLocale());
  const localeRequestRef = useRef(0);
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    getUiAppearancePreference(),
  );
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        ref={panelRef}
        data-testid="user-settings"
        showCloseButton={false}
        initialFocus={() => (focusUsage ? usageRef.current : panelRef.current)}
        className="rk-scroll block max-h-[calc(100%-2rem)] w-[640px] overflow-y-auto overscroll-contain rounded-2xl p-6 sm:max-h-[calc(100%-5rem)] sm:max-w-[calc(100%-5rem)] sm:p-8"
      >
        <div className="flex items-start justify-between gap-6">
          <DialogTitle className="text-2xl font-medium text-foreground">
            <Trans>Settings</Trans>
          </DialogTitle>
          <DialogClose
            aria-label={t`Close user settings`}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>

        <section className="mt-8 rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Account</Trans>
          </h3>
          <p className="mt-3 text-[14px] text-foreground/75">{name}</p>
          {email ? <p className="mt-1 text-[13px] text-muted-foreground/70">{email}</p> : null}
        </section>

        <ChangePasswordSection />

        {messagingEnabled && onOpenMessaging ? (
          <section className="mt-5 rounded-xl border border-border px-4 py-4">
            <h3 className="text-[15px] font-medium text-foreground">
              <Trans>Messaging</Trans>
            </h3>
            <p className="mt-3 text-[13px] text-muted-foreground/70">
              <Trans>Chat apps, group channels, and agent connections.</Trans>
            </p>
            <Button variant="secondary" className="mt-3 rounded-full" onClick={onOpenMessaging}>
              <Trans>Manage messaging settings</Trans>
            </Button>
          </section>
        ) : null}

        <section className="mt-5 rounded-xl border border-border px-4 py-4">
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
        </section>

        <section className="mt-5 rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Language</Trans>
          </h3>
          <UiLocalePicker value={locale} onChange={chooseLocale} />
        </section>

        <section className="mt-5 rounded-xl border border-border px-4 py-4">
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

        <div
          ref={usageRef}
          tabIndex={-1}
          data-testid="usage-settings"
          className="mt-5 rounded-xl border border-border px-4 py-4 outline-none"
        >
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Usage</Trans>
          </h3>
          {usage ? (
            <p className="mt-3 text-[14px] text-foreground/75">
              <Trans>
                {usage.runs} runs · {usage.inputTokens + usage.outputTokens} tokens
              </Trans>
            </p>
          ) : null}
          <p className={`text-[12.5px] text-muted-foreground/80 ${usage ? "mt-2" : "mt-3"}`}>
            <Trans>Model spend uses your provider keys.</Trans>
          </p>
        </div>

        <SoftwareUpdateSection isDeploymentOwner={isDeploymentOwner} />

        {isDeploymentOwner && computersAreUnavailable(sandboxProvider) ? (
          <div
            data-testid="computers-setup-settings"
            className="mt-5 rounded-xl border border-border px-4 py-4"
          >
            <h3 className="text-[15px] font-medium text-foreground">
              <Trans>Computers</Trans>
            </h3>
            <ComputersUnavailableHint className="mt-3 text-[13px] leading-relaxed text-muted-foreground" />
          </div>
        ) : null}

        <details
          data-testid="advanced-settings"
          className="group mt-5 rounded-xl border border-border"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 text-[14px] text-foreground/75">
            <span>
              <span className="block text-[15px] text-foreground">
                <Trans>Advanced</Trans>
              </span>
              <span className="mt-1 block text-[12.5px] text-muted-foreground/80">
                <Trans>Optional controls most people never need</Trans>
              </span>
            </span>
            <span aria-hidden="true" className="transition-transform group-open:rotate-90">
              ›
            </span>
          </summary>
          <div className="border-t border-border px-4 pb-5">
            <ApprovalRulesSettings />
          </div>
        </details>
      </DialogContent>
    </Dialog>
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
    <section className="mt-5 rounded-xl border border-border px-4 py-4">
      <h3 className="text-[15px] font-medium text-foreground">
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
        className="flex h-9 w-full items-center justify-between rounded-lg border border-input bg-transparent px-3 text-start text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="min-w-0 truncate">{UI_LOCALE_LABELS[value]}</span>
        <span className="ml-3 shrink-0 text-muted-foreground" aria-hidden="true">
          <ChevronDown size={16} strokeWidth={1.8} />
        </span>
      </button>
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t`Language`}
          className="rk-scroll absolute left-0 right-0 top-full z-20 mt-1 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
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
              className={`w-full rounded-md px-2 py-1.5 text-start text-sm outline-none hover:bg-accent focus-visible:bg-accent ${
                code === value ? "bg-accent" : ""
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
