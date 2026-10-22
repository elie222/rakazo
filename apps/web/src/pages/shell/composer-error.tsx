import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { MODEL_REQUIRED_SEND_ERROR, normalizeRunError } from "@rakazo/core";
import { X } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { translateRunError } from "../../lib/run-error";

export function ComposerError({
  sendError,
  runError,
  runErrorId,
  onRunErrorPresented,
  onOpenModels,
  onDismissError,
  textareaRef,
}: {
  sendError: string | null;
  runError: string | null;
  runErrorId: string | null;
  onRunErrorPresented: (runId: string) => void;
  onOpenModels: () => void;
  onDismissError: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useLingui();
  const runErrorRef = useRef<HTMLDivElement>(null);
  const presentedRunErrorIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!runError || !runErrorId) return;
    const currentRunErrorId = runErrorId;
    let frame = 0;
    function recordIfPresented() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = runErrorRef.current;
        if (!element || document.visibilityState !== "visible") return;
        const rect = element.getBoundingClientRect();
        const topElement = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        if (topElement && (topElement === element || element.contains(topElement))) {
          if (presentedRunErrorIdRef.current === currentRunErrorId) return;
          presentedRunErrorIdRef.current = currentRunErrorId;
          onRunErrorPresented(currentRunErrorId);
        }
      });
    }
    recordIfPresented();
    const observer = new MutationObserver(recordIfPresented);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("transitionend", recordIfPresented);
    document.addEventListener("visibilitychange", recordIfPresented);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("transitionend", recordIfPresented);
      document.removeEventListener("visibilitychange", recordIfPresented);
    };
  }, [onRunErrorPresented, runError, runErrorId]);

  return sendError || runError ? (
    <div
      ref={runErrorRef}
      role="alert"
      data-testid="composer-error"
      className="mb-3 flex items-center gap-2 rounded-[14px] border border-destructive/40 bg-destructive/10 px-4 py-2 text-[13px] text-destructive animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none"
    >
      <div className="min-w-0 flex-1">
        {sendError === MODEL_REQUIRED_SEND_ERROR ? (
          <button
            type="button"
            data-testid="composer-error-open-models"
            onClick={onOpenModels}
            className="text-left underline underline-offset-2 hover:text-foreground"
          >
            {sendError}
          </button>
        ) : (
          (sendError ??
          (runError
            ? normalizeRunError(runError, translateRunError, i18n.locale || "en").summary
            : null))
        )}
        {!sendError && runError ? (
          <details key={runError} className="mt-1">
            <summary className="w-fit cursor-pointer">{t`Details`}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{runError}</pre>
          </details>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={t`Dismiss error`}
        data-testid="composer-error-dismiss"
        onClick={() => {
          onDismissError();
          window.requestAnimationFrame(() => textareaRef.current?.focus());
        }}
        className="shrink-0 text-destructive hover:text-foreground"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  ) : null;
}
