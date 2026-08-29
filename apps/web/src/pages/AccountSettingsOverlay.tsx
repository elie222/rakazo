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
import {
  ComputersUnavailableHint,
  computersAreUnavailable,
} from "../components/ComputersUnavailableHint";
import { SoftwareUpdateSection } from "../components/SoftwareUpdateSection";
import { getActiveUiLocale, setUiLocale } from "../lib/i18n";
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
  onClose: () => void;
}) {
  const { t } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const usageRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [locale, setLocale] = useState<UiLocale>(() => getActiveUiLocale());
  const localeRequestRef = useRef(0);
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
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(4,4,5,.62)] p-4 sm:p-10">
      <div
        ref={panelRef}
        data-testid="user-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-settings-title"
        tabIndex={-1}
        className="rk-scroll max-h-full w-[640px] max-w-full overflow-y-auto rounded-[26px] border border-[#232326] bg-[#141416] p-6 shadow-[0_40px_90px_rgba(0,0,0,.55)] sm:p-8"
      >
        <div className="flex items-start justify-between gap-6">
          <div>
            <h2 id="account-settings-title" className="text-2xl font-medium text-[#F1F1F2]">
              <Trans>Settings</Trans>
            </h2>
          </div>
          <button
            type="button"
            aria-label={t`Close user settings`}
            onClick={onClose}
            className="text-[#85858A]"
          >
            ✕
          </button>
        </div>

        <section className="mt-8 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-4">
          <h3 className="text-[15px] font-medium text-[#ECECEE]">
            <Trans>Account</Trans>
          </h3>
          <p className="mt-3 text-[14px] text-[#C9C9CE]">{name}</p>
          {email ? <p className="mt-1 text-[13px] text-[#7A7A80]">{email}</p> : null}
        </section>

        <section className="mt-5 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-4">
          <h3 className="text-[15px] font-medium text-[#ECECEE]">
            <Trans>Language</Trans>
          </h3>
          <UiLocalePicker value={locale} onChange={chooseLocale} />
        </section>

        <section className="mt-5 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-4">
          <h3 className="text-[15px] font-medium text-[#ECECEE]">
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
                  className={`flex items-center gap-3 rounded-[12px] border px-3.5 py-3 text-start text-[14px] text-[#ECECEE] transition-colors disabled:opacity-50 ${
                    selected
                      ? "border-[#5A5A62] bg-[#1A1A1D]"
                      : "border-[#26262A] hover:border-[#3A3A40]"
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
            <p role="alert" className="mt-3 text-[12.5px] text-[#F1A8A8]">
              {avatarError}
            </p>
          ) : null}
        </section>

        <div
          ref={usageRef}
          tabIndex={-1}
          data-testid="usage-settings"
          className="mt-5 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-4 outline-none"
        >
          <h3 className="text-[15px] font-medium text-[#ECECEE]">
            <Trans>Usage</Trans>
          </h3>
          {usage ? (
            <p className="mt-3 text-[14px] text-[#C9C9CE]">
              <Trans>
                {usage.runs} runs · {usage.inputTokens + usage.outputTokens} tokens
              </Trans>
            </p>
          ) : null}
          <p className={`text-[12.5px] text-[#6C6C70] ${usage ? "mt-2" : "mt-3"}`}>
            <Trans>Model spend uses your provider keys.</Trans>
          </p>
        </div>

        <SoftwareUpdateSection isDeploymentOwner={isDeploymentOwner} />

        {isDeploymentOwner && computersAreUnavailable(sandboxProvider) ? (
          <div
            data-testid="computers-setup-settings"
            className="mt-5 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-4"
          >
            <h3 className="text-[15px] font-medium text-[#ECECEE]">
              <Trans>Computers</Trans>
            </h3>
            <ComputersUnavailableHint className="mt-3 text-[13px] leading-relaxed text-[#85858A]" />
          </div>
        ) : null}

        <details
          data-testid="advanced-settings"
          className="group mt-5 rounded-[14px] border border-[#26262A] bg-[#101012]"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 text-[14px] text-[#A8A8AD]">
            <span>
              <span className="block text-[15px] text-[#ECECEE]">
                <Trans>Advanced</Trans>
              </span>
              <span className="mt-1 block text-[12.5px] text-[#6C6C70]">
                <Trans>Optional controls most people never need</Trans>
              </span>
            </span>
            <span aria-hidden="true" className="transition-transform group-open:rotate-90">
              ›
            </span>
          </summary>
          <div className="border-t border-[#232326] px-4 pb-5">
            <ApprovalRulesSettings />
          </div>
        </details>
      </div>
    </div>
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
        className="flex w-full items-center justify-between rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-start text-[#ECECEE] outline-none focus-visible:border-[#4A4A50]"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="min-w-0 truncate">{UI_LOCALE_LABELS[value]}</span>
        <span className="ml-3 shrink-0 text-[#85858A]" aria-hidden="true">
          <ChevronDown size={16} strokeWidth={1.8} />
        </span>
      </button>
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t`Language`}
          className="rk-scroll absolute left-0 right-0 top-full z-20 mt-2 overflow-y-auto rounded-[11px] border border-[#26262A] bg-[#101012] p-1 shadow-[0_20px_45px_rgba(0,0,0,.55)]"
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
              className={`w-full rounded-[8px] px-3 py-2 text-start text-[13.5px] text-[#ECECEE] outline-none hover:bg-[#1A1A1D] focus-visible:bg-[#1A1A1D] ${
                code === value ? "bg-[#1A1A1D]" : ""
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
