import type {
  AnalyticsModelSignInStep,
  ModelOAuthBegin,
  ModelSignInCancelReason,
  SettingsScope,
  ThinkingLevel,
} from "@rakazo/contracts";
import { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import {
  analyticsSurface,
  desktopBridge,
  oauthStateOf,
  onDesktopOAuthCallback,
} from "../platform/desktop";
import { useSpaceRpc } from "../query/space-rpc";
import { errorText } from "../query/user-error";
import { waitForModelOAuth } from "./model-auth";

export type ModelOAuthSignInBegin = {
  provider: string;
  /** The connection to sign in again; null adds another. */
  credentialId?: string | null;
  modelId?: string;
  thinkingLevel?: ThinkingLevel | null;
  makeDefault?: boolean;
  /** Where makeDefault sets the main model. */
  scope?: SettingsScope;
  label?: string;
};

/**
 * Shared subscription sign-in lifecycle for desktop loopback capture and the
 * paste fallback. Preserves attempt-owned capture unsubscribe and submitting
 * guards so cancel-and-retry cannot drop a newer callback.
 */
export function useModelOAuthSignIn(options: {
  /** `credentialId` is the connection the sign-in saved. */
  onFinished: (controller: AbortController, credentialId: string) => void | Promise<void>;
  onError: (message: string) => void;
  onClearError?: () => void;
}) {
  const rpc = useSpaceRpc();
  const { onFinished, onError, onClearError } = options;
  const [oauth, setOauth] = useState<ModelOAuthBegin | null>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [oauthPending, setOauthPending] = useState(false);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthLoginIdRef = useRef<string | null>(null);
  const oauthCodeSubmittingRef = useRef(false);
  const oauthCaptureRef = useRef<(() => void) | null>(null);
  const reportedStepsRef = useRef(new Set<string>());
  const onFinishedRef = useRef(onFinished);
  const onErrorRef = useRef(onError);
  const onClearErrorRef = useRef(onClearError);
  onFinishedRef.current = onFinished;
  onErrorRef.current = onError;
  onClearErrorRef.current = onClearError;

  /** Tells the server a step only this app sees, once per sign-in. A caller that waits
   *  before reporting names the sign-in it began with, so a newer one never inherits it. */
  function reportSignInStep(
    step: AnalyticsModelSignInStep,
    loginId: string | null = oauthLoginIdRef.current,
  ) {
    const key = `${loginId}:${step}`;
    if (!loginId || reportedStepsRef.current.has(key)) return;
    reportedStepsRef.current.add(key);
    void rpc.analytics.modelSignInStep({ loginId, step }).catch(() => undefined);
  }

  function releaseOAuthCapture(expected?: (() => void) | null) {
    if (expected !== undefined && oauthCaptureRef.current !== expected) return;
    oauthCaptureRef.current?.();
    oauthCaptureRef.current = null;
  }

  /** Stops the sign-in in progress; `reason` says why for measurement only. */
  function cancelOAuthAttempt(reason: ModelSignInCancelReason = "cancelled", resetState = true) {
    releaseOAuthCapture();
    oauthCodeSubmittingRef.current = false;
    const loginId = oauthLoginIdRef.current;
    oauthLoginIdRef.current = null;
    cancelModelOAuthAttempt(oauthAbortRef, () => {
      if (resetState) {
        setOauth(null);
        setOauthPending(false);
      }
    });
    if (loginId) void rpc.models.cancelOAuth({ loginId, reason }).catch(() => undefined);
  }

  async function finishSubscriptionSignIn(loginId: string, controller: AbortController) {
    await waitForModelOAuth(loginId, controller.signal, rpc);
    if (controller.signal.aborted) return;
    const saved = await rpc.models.finishOAuth({ loginId }, { signal: controller.signal });
    if (controller.signal.aborted) return;
    oauthLoginIdRef.current = null;
    setOauth(null);
    // Keep post-connect UI work outside the OAuth try/catch so a refresh failure
    // is not reported as a failed sign-in (finishOAuth already persisted).
    try {
      await onFinishedRef.current(controller, saved.id);
    } catch (err) {
      if (controller.signal.aborted) return;
      onErrorRef.current(errorText(err, "Connected, but could not refresh"));
    }
  }

  async function submitOAuthCode(captured?: string, login?: ModelOAuthBegin) {
    const attempt = login ?? oauth;
    if (attempt?.mode !== "auth-url" || oauthCodeSubmittingRef.current) return;
    const controller = oauthAbortRef.current;
    const capture = oauthCaptureRef.current;
    const code = (captured ?? pasteCode).trim();
    if (!controller || !code) return;
    oauthCodeSubmittingRef.current = true;
    setPasteCode("");
    onClearErrorRef.current?.();
    let submitted = false;
    let retryable = false;
    try {
      await rpc.models.submitOAuthCode(
        { loginId: attempt.loginId, code },
        { signal: controller.signal },
      );
      submitted = true;
      await finishSubscriptionSignIn(attempt.loginId, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (submitted) {
        oauthLoginIdRef.current = null;
        setOauth(null);
        void rpc.models
          .cancelOAuth({ loginId: attempt.loginId, reason: "interrupted" })
          .catch(() => undefined);
      } else {
        retryable = true;
        setPasteCode(code);
      }
      onErrorRef.current(errorText(err, "Could not finish sign-in"));
    } finally {
      // A cancelled attempt may already have started another sign-in; do not clear
      // its submitting guard or the newer desktop callback is dropped.
      if (oauthAbortRef.current === controller) {
        oauthCodeSubmittingRef.current = false;
      }
      if (!retryable) {
        // Only drop this attempt's listener — a newer sign-in may already own the ref.
        releaseOAuthCapture(capture);
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
    }
  }

  async function startSubscriptionSignIn(begin: ModelOAuthSignInBegin) {
    onClearErrorRef.current?.();
    setOauthPending(true);
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    let waitingForCode = false;
    try {
      const started = await rpc.models.beginOAuth(
        {
          provider: begin.provider,
          ...(begin.credentialId !== undefined ? { credentialId: begin.credentialId } : {}),
          modelId: begin.modelId,
          thinkingLevel: begin.thinkingLevel,
          makeDefault: begin.makeDefault,
          ...(begin.scope ? { scope: begin.scope } : {}),
          label: begin.label,
          // A desktop that opens the browser itself receives the loopback redirect; anywhere
          // else the person opens the page from a link, so it shows a code to paste.
          codePage: !desktopBridge()?.oauth.open,
          surface: analyticsSurface(),
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      oauthLoginIdRef.current = started.loginId;
      setPasteCode("");
      setOauth(started);
      // Only desktop opens the page here; a browser blocks a tab opened after this await,
      // so there the card's link opens it from the user's own click.
      if (started.mode === "auth-url") {
        // Subscribe before the popup exists: a provider that is already
        // authorized can redirect before React commits the state above.
        releaseOAuthCapture();
        oauthCaptureRef.current = onDesktopOAuthCallback(
          (code) => void submitOAuthCode(code, started),
          oauthStateOf(started.verificationUri),
        );
        const browserAuth = desktopBridge()?.oauth;
        if (browserAuth?.open) {
          const cancelBrowser = () =>
            void browserAuth.cancel?.(started.verificationUri).catch(() => undefined);
          controller.signal.addEventListener("abort", cancelBrowser, { once: true });
          const releaseCapture = oauthCaptureRef.current;
          oauthCaptureRef.current = () => {
            releaseCapture?.();
            controller.signal.removeEventListener("abort", cancelBrowser);
            cancelBrowser();
          };
          await browserAuth.open(started.verificationUri);
          if (controller.signal.aborted) return;
          reportSignInStep("page_opened", started.loginId);
        }
      }
      waitingForCode = started.mode === "auth-url";
      if (!waitingForCode) await finishSubscriptionSignIn(started.loginId, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      const loginId = oauthLoginIdRef.current;
      oauthLoginIdRef.current = null;
      if (loginId) {
        void rpc.models.cancelOAuth({ loginId, reason: "interrupted" }).catch(() => undefined);
      }
      onErrorRef.current(errorText(err, "Could not start sign-in"));
      setOauth(null);
    } finally {
      if (!waitingForCode) {
        if (oauthAbortRef.current === controller) releaseOAuthCapture();
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
    }
  }

  useEffect(() => () => cancelOAuthAttempt("left", false), []);

  return {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    cancelOAuthAttempt,
    reportSignInStep,
    startSubscriptionSignIn,
    submitOAuthCode,
  };
}
