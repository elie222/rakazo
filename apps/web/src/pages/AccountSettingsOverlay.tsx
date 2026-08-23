import { useEffect, useRef } from "react";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";

export function AccountSettingsOverlay({
  email,
  name,
  onClose,
}: {
  email?: string | null;
  name: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", handleKeyDown);
    panelRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

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
              Settings
            </h2>
            <p className="mt-1 text-[13.5px] text-[#7A7A80]">
              Account preferences apply across all your bots.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close user settings"
            onClick={onClose}
            className="text-[#85858A]"
          >
            ✕
          </button>
        </div>

        <section className="mt-8 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-4">
          <h3 className="text-[15px] font-medium text-[#ECECEE]">Account</h3>
          <p className="mt-3 text-[14px] text-[#C9C9CE]">{name}</p>
          {email ? <p className="mt-1 text-[13px] text-[#7A7A80]">{email}</p> : null}
        </section>

        <details
          data-testid="advanced-settings"
          className="group mt-5 rounded-[14px] border border-[#26262A] bg-[#101012]"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 text-[14px] text-[#A8A8AD]">
            <span>
              <span className="block text-[15px] text-[#ECECEE]">Advanced</span>
              <span className="mt-1 block text-[12.5px] text-[#6C6C70]">
                Optional controls most people never need
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
