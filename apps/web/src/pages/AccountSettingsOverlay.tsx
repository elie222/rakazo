import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { getActiveUiLocale, setUiLocale } from "../lib/i18n";
import { UI_LOCALE_LABELS, UI_LOCALES, type UiLocale } from "../lib/ui-locale";

export function AccountSettingsOverlay({
  email,
  name,
  usage,
  focusUsage,
  onClose,
}: {
  email?: string | null;
  name: string;
  usage?: { runs: number; inputTokens: number; outputTokens: number } | null;
  focusUsage?: boolean;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const usageRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [locale, setLocale] = useState<UiLocale>(() => getActiveUiLocale());
  const [localeBusy, setLocaleBusy] = useState(false);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", handleKeyDown);
    if (focusUsage) usageRef.current?.focus();
    else panelRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [focusUsage]);

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
            <p className="mt-1 text-[13.5px] text-[#7A7A80]">
              <Trans>Account preferences apply across all your bots.</Trans>
            </p>
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
          <label className="mt-3 block">
            <span className="sr-only">
              <Trans>Language</Trans>
            </span>
            <select
              data-testid="ui-locale-select"
              className="w-full rounded-xl border border-[#2A2A2E] bg-[#16161A] px-3 py-2.5 text-[14px] text-[#ECECEE] outline-none"
              value={locale}
              disabled={localeBusy}
              aria-label={t`Language`}
              onChange={(event) => {
                const next = event.target.value as UiLocale;
                setLocale(next);
                setLocaleBusy(true);
                void setUiLocale(next).finally(() => setLocaleBusy(false));
              }}
            >
              {UI_LOCALES.map((code) => (
                <option key={code} value={code}>
                  {UI_LOCALE_LABELS[code]}
                </option>
              ))}
            </select>
          </label>
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
