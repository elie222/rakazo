import type { ModelOAuthBegin } from "@rakazo/contracts";
import { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import { oauthStateOf, onDesktopOAuthCallback } from "./desktop";
import { waitForModelOAuth } from "./model-auth";
import { rpc } from "./rpc";

export type ModelOAuthSignInBegin = {
  provider: string;
  modelId?: string;
  label?: string;
};

/**
 * Shared subscription sign-in lifecycle for desktop loopback capture and the
 * paste fallback. Preserves attempt-owned capture unsubscribe and submitting
 * guards so cancel-and-retry cannot drop a newer callback.
 */
export function useModelOAuthSignIn(options: {
  onFinished: (controller: AbortController) => void | Promise<void>;
  onError: (message: string) => void;
  onClearError?: () => void;
}) {
  const { onFinished, onError, onClearError } = options;
  const [oauth, setOauth] = useState<ModelOAuthBegin | null>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [oauthPending, setOauthPending] = useState(false);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthLoginIdRef = useRef<string | null>(null);
  const oauthCodeSubmittingRef = useRef(false);
  const oauthCaptureRef = useRef<(() => void) | null>(null);
  const onFinishedRef = useRef(onFinished);
  const onErrorRef = useRef(onError);
  const onClearErrorRef = useRef(onClearError);
  onFinishedRef.current = onFinished;
  onErrorRef.current = onError;
  onClearErrorRef.current = onClearError;

  function releaseOAuthCapture(expected?: (() => void) | null) {
    if (expected !== undefined && oauthCaptureRef.current !== expected) return;
    oauthCaptureRef.current?.();
    oauthCaptureRef.current = null;
  }

  function cancelOAuthAttempt(resetState = true) {
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
    if (loginId) void rpc.models.cancelOAuth({ loginId }).catch(() => undefined);
  }

  async function finishSubscriptionSignIn(loginId: string, controller: AbortController) {
    await waitForModelOAuth(loginId, controller.signal);
    if (controller.signal.aborted) return;
    await rpc.models.finishOAuth({ loginId }, { signal: controller.signal });
    if (controller.signal.aborted) return;
    oauthLoginIdRef.current = null;
    setOauth(null);
    // Keep post-connect UI work outside the OAuth try/catch so a refresh failure
    // is not reported as a failed sign-in (finishOAuth already persisted).
    try {
      await onFinishedRef.current(controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      onErrorRef.current(err instanceof Error ? err.message : "Connected, but could not refresh");
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
        void rpc.models.cancelOAuth({ loginId: attempt.loginId }).catch(() => undefined);
      } else {
        retryable = true;
        setPasteCode(code);
      }
      onErrorRef.current(err instanceof Error ? err.message : "Could not finish sign-in");
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
          modelId: begin.modelId,
          label: begin.label,
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      oauthLoginIdRef.current = started.loginId;
      setPasteCode("");
      setOauth(started);
      if (started.mode === "auth-url") {
        // Subscribe before the popup exists: a provider that is already
        // authorized can redirect before React commits the state above.
        releaseOAuthCapture();
        oauthCaptureRef.current = onDesktopOAuthCallback(
          (code) => void submitOAuthCode(code, started),
          oauthStateOf(started.verificationUri),
        );
      }
      window.open(started.verificationUri, "_blank", "noopener,noreferrer");
      waitingForCode = started.mode === "auth-url";
      if (!waitingForCode) await finishSubscriptionSignIn(started.loginId, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      const loginId = oauthLoginIdRef.current;
      oauthLoginIdRef.current = null;
      if (loginId) void rpc.models.cancelOAuth({ loginId }).catch(() => undefined);
      onErrorRef.current(err instanceof Error ? err.message : "Could not start sign-in");
      setOauth(null);
    } finally {
      if (!waitingForCode) {
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
    }
  }

  useEffect(() => () => cancelOAuthAttempt(false), []);

  return {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  };
}
