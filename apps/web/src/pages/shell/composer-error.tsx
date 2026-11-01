import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { isModelRequiredSendError, normalizeRunError } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { FileIcon, X } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useId, useRef } from "react";
import { translateRunError } from "../../lib/run-error";

/**
 * While an undismissed error card sits on screen, check once a second whether it
 * is still covered. Only the one element is hit-tested, never the whole document.
 */
const RUN_ERROR_RETRY_MS = 1_000;

export function ComposerError({
  sendError,
  imageConfirmation = false,
  onSendAsFile,
  runError,
  runErrorId,
  onRunErrorPresented,
  onOpenModels,
  onOpenConnections,
  onDismissError,
  textareaRef,
}: {
  sendError: string | null;
  /** A recoverable image/model mismatch: a warning with its two ways forward. */
  imageConfirmation?: boolean;
  onSendAsFile?: () => void;
  runError: string | null;
  runErrorId: string | null;
  onRunErrorPresented: (runId: string) => void;
  onOpenModels: () => void;
  onOpenConnections: () => void;
  onDismissError: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useLingui();
  const runErrorRef = useRef<HTMLDivElement>(null);
  const fileNoteId = useId();
  const presentedRunErrorIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!runError || !runErrorId) return;
    const currentRunErrorId = runErrorId;
    let retry: number | undefined;
    function stopRetry() {
      if (retry === undefined) return;
      window.clearInterval(retry);
      retry = undefined;
    }
    // Counts the error as presented once it is actually on screen. Watching
    // every DOM mutation and hit-testing the element on each one forced layout
    // for the whole session; an IntersectionObserver costs nothing until the
    // card scrolls into view.
    function recordIfPresented() {
      const element = runErrorRef.current;
      if (!element || document.visibilityState !== "visible") return;
      if (presentedRunErrorIdRef.current === currentRunErrorId) {
        stopRetry();
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      // Without hit testing (older engines, test DOMs) an element with a box is
      // on screen, which is all this check can know.
      if (typeof document.elementFromPoint !== "function") {
        presentedRunErrorIdRef.current = currentRunErrorId;
        onRunErrorPresented(currentRunErrorId);
        stopRetry();
        return;
      }
      const topElement = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      if (topElement && (topElement === element || element.contains(topElement))) {
        presentedRunErrorIdRef.current = currentRunErrorId;
        onRunErrorPresented(currentRunErrorId);
        stopRetry();
      }
    }
    // A card can be on screen and still covered by a sheet or a dialog, and
    // nothing fires when that cover goes away. Re-check on a slow timer while
    // the card intersects, until it is either presented or gone.
    function watchUntilPresented() {
      recordIfPresented();
      if (presentedRunErrorIdRef.current === currentRunErrorId) return;
      retry ??= window.setInterval(recordIfPresented, RUN_ERROR_RETRY_MS);
    }
    const element = runErrorRef.current;
    const observer =
      element && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) watchUntilPresented();
            else stopRetry();
          })
        : null;
    if (observer && element) observer.observe(element);
    // Without an observer the card is on screen as soon as it mounts.
    else watchUntilPresented();
    document.addEventListener("visibilitychange", watchUntilPresented);
    return () => {
      observer?.disconnect();
      stopRetry();
      document.removeEventListener("visibilitychange", watchUntilPresented);
    };
  }, [onRunErrorPresented, runError, runErrorId]);
  const normalizedRunError = runError
    ? normalizeRunError(runError, translateRunError, i18n.locale || "en")
    : null;
  // The one action that fixes the failure; a transient one already says to try again.
  const recovery = sendError ? undefined : normalizedRunError?.recovery;
  const recoveryAction =
    recovery === "model"
      ? { label: t`Choose a model`, onClick: onOpenModels }
      : recovery === "connection"
        ? {
            label: normalizedRunError?.kind === "auth" ? t`Replace key` : t`Connect a model`,
            onClick: onOpenConnections,
          }
        : null;

  const warning = Boolean(sendError) && imageConfirmation;
  return sendError || runError ? (
    <div
      ref={runErrorRef}
      role="alert"
      data-testid="composer-error"
      className={`mb-3 flex items-center gap-2 rounded-[14px] border px-4 py-2 text-[13px] animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none ${warning ? "border-warning/40 bg-warning/10 text-warning" : "border-destructive/40 bg-destructive/10 text-destructive"}`}
    >
      <div className="min-w-0 flex-1">
        {isModelRequiredSendError(sendError) ? (
          <button
            type="button"
            data-testid="composer-error-open-models"
            onClick={onOpenModels}
            className="text-left underline underline-offset-2 hover:text-foreground"
          >
            {sendError}
          </button>
        ) : (
          (sendError ?? normalizedRunError?.summary ?? null)
        )}
        {warning && onSendAsFile ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-describedby={fileNoteId}
              onClick={onSendAsFile}
            >
              <FileIcon data-icon="inline-start" aria-hidden="true" />
              {t`Send as file`}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onOpenModels}>
              {t`Change model`}
            </Button>
            <p id={fileNoteId} className="basis-full text-xs text-muted-foreground">
              {t`The bot can use the file but won't see the picture.`}
            </p>
          </div>
        ) : null}
        {recoveryAction ? (
          <>
            {" "}
            <button
              type="button"
              data-testid="composer-error-action"
              onClick={recoveryAction.onClick}
              className="font-medium underline underline-offset-2 hover:text-foreground"
            >
              {recoveryAction.label}
            </button>
          </>
        ) : null}
        {!sendError && runError ? (
          <details key={runError} className="mt-1">
            <summary className="w-fit cursor-pointer">{t`Details`}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
              {normalizedRunError?.details}
            </pre>
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
        className={`shrink-0 hover:text-foreground ${warning ? "text-warning" : "text-destructive"}`}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  ) : null;
}
