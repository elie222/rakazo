import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type {
  AnalyticsModelSignInStep,
  ModelOAuthBegin,
  ModelSignInCancelReason,
  ThinkingLevel,
} from "@rakazo/contracts";
import { clampCatalogThinkingLevel } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import type { RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import { Linking } from "react-native";
import type { rpc as apiRpc } from "../api/api";
import type { MobileModel, MobileModelCredential } from "../api/mobile-types";
import { errorText } from "../api/user-error";
import {
  cancelModelOAuthAttempt,
  finishModelOAuthAttempt,
  waitForModelOAuth,
} from "../models/model-auth";
import { analyticsSurface } from "../native/analytics-surface";
import type { SettingsTarget } from "../query/settings-target";

type SubscriptionSignInOptions = {
  rpc: typeof apiRpc;
  selected: MobileModel | undefined;
  thinkingLevel: ThinkingLevel | null;
  makeDefault: boolean;
  scope: SettingsTarget["scope"];
  credentialIdRef: RefObject<string | null>;
  setCredentialId: (id: string) => void;
  onSaved?: (credential: MobileModelCredential) => void;
  modelId: string;
  load: (preferred: { modelId?: string }) => Promise<unknown>;
  finishConnecting: (connectedModelId: string, connectedCredentialId: string) => Promise<boolean>;
  publishFeedback: (
    anchor: "connection",
    next: { error?: string | null; notice?: string | null },
  ) => void;
  clearFeedback: () => void;
};

/** Signing in to a model subscription in the browser, by link or by pasted code. */
export function useSubscriptionSignIn({
  rpc,
  selected,
  thinkingLevel,
  makeDefault,
  scope,
  credentialIdRef,
  setCredentialId,
  onSaved,
  modelId,
  load,
  finishConnecting,
  publishFeedback,
  clearFeedback,
}: SubscriptionSignInOptions) {
  const { t } = useLingui();
  const [oauth, setOauth] = useState<ModelOAuthBegin | null>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [oauthPending, setOauthPending] = useState(false);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthLoginIdRef = useRef<string | null>(null);
  const oauthCodeSubmittingRef = useRef(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const codeCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reportedStepsRef = useRef(new Set<string>());

  /** Tells the server a step only this app sees, once per sign-in. The caller names the
   *  sign-in it began with, so a newer one never inherits a step that settles late. */
  const reportSignInStep = useCallback(
    (step: AnalyticsModelSignInStep, loginId: string | null) => {
      const key = `${loginId}:${step}`;
      if (!loginId || reportedStepsRef.current.has(key)) return;
      reportedStepsRef.current.add(key);
      void rpc("analytics/modelSignInStep", { loginId, step }).catch(() => undefined);
    },
    [rpc],
  );

  const openSignInPage = useCallback(
    async (url: string) => {
      const loginId = oauthLoginIdRef.current;
      await Linking.openURL(url);
      reportSignInStep("page_opened", loginId);
    },
    [reportSignInStep],
  );

  const copyOAuthCode = useCallback(
    (code: string) => {
      const loginId = oauthLoginIdRef.current;
      void Clipboard.setStringAsync(code)
        .then(() => {
          reportSignInStep("code_copied", loginId);
          setCodeCopied(true);
          if (codeCopiedTimerRef.current) clearTimeout(codeCopiedTimerRef.current);
          codeCopiedTimerRef.current = setTimeout(() => setCodeCopied(false), 1600);
        })
        .catch(() => undefined);
    },
    [reportSignInStep],
  );

  /** Stops the sign-in in progress; `reason` says why for measurement only. */
  const cancelOAuth = useCallback(
    (reason: ModelSignInCancelReason = "cancelled") => {
      const loginId = oauthLoginIdRef.current;
      oauthLoginIdRef.current = null;
      oauthCodeSubmittingRef.current = false;
      cancelModelOAuthAttempt(oauthAbortRef, () => {
        setOauth(null);
        setOauthPending(false);
      });
      if (loginId) void rpc("models/cancelOAuth", { loginId, reason }).catch(() => undefined);
    },
    [rpc],
  );

  /** Stops a sign-in the person left and the pending reset of the Copied label. */
  const leaveSignIn = useCallback(() => {
    cancelOAuth("left");
    if (codeCopiedTimerRef.current) clearTimeout(codeCopiedTimerRef.current);
  }, [cancelOAuth]);

  async function finishSubscriptionSignIn(login: ModelOAuthBegin, controller: AbortController) {
    await waitForModelOAuth(login, controller.signal, rpc);
    if (controller.signal.aborted) return;
    const saved = await rpc(
      "models/finishOAuth",
      { loginId: login.loginId },
      { signal: controller.signal },
    );
    if (controller.signal.aborted) return;
    oauthLoginIdRef.current = null;
    credentialIdRef.current = saved.id;
    setCredentialId(saved.id);
    onSaved?.(saved);
    setOauth(null);
    if (await finishConnecting(selected?.id ?? modelId, saved.id)) return;
    await load({ modelId });
    if (controller.signal.aborted) return;
    publishFeedback("connection", { notice: t`Saved.` });
  }

  async function startSubscriptionSignIn() {
    if (!selected) return;
    clearFeedback();
    setOauthPending(true);
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    let waitingForCode = false;
    try {
      const started = await rpc(
        "models/beginOAuth",
        {
          provider: selected.provider,
          modelId: selected.id,
          thinkingLevel: clampCatalogThinkingLevel(
            thinkingLevel,
            selected.thinkingLevels,
          ) as ThinkingLevel | null,
          makeDefault,
          scope,
          label: selected.providerName ?? selected.provider,
          credentialId: credentialIdRef.current,
          codePage: true,
          surface: analyticsSurface(),
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      oauthLoginIdRef.current = started.loginId;
      setPasteCode("");
      setOauth(started);
      // A device code must be read before its page opens, so the person opens that page.
      if (started.mode === "auth-url") await openSignInPage(started.verificationUri);
      waitingForCode = started.mode === "auth-url";
      if (!waitingForCode) await finishSubscriptionSignIn(started, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      const loginId = oauthLoginIdRef.current;
      oauthLoginIdRef.current = null;
      if (loginId) {
        void rpc("models/cancelOAuth", { loginId, reason: "interrupted" }).catch(() => undefined);
      }
      publishFeedback("connection", {
        error: errorText(err, t`Could not start sign-in`),
      });
      setOauth(null);
    } finally {
      if (!waitingForCode) {
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
    }
  }

  async function submitOAuthCode() {
    if (oauth?.mode !== "auth-url" || oauthCodeSubmittingRef.current) return;
    const controller = oauthAbortRef.current;
    const code = pasteCode.trim();
    if (!controller || !code) return;
    oauthCodeSubmittingRef.current = true;
    setPasteCode("");
    clearFeedback();
    let submitted = false;
    let retryable = false;
    try {
      await rpc(
        "models/submitOAuthCode",
        { loginId: oauth.loginId, code },
        {
          signal: controller.signal,
        },
      );
      submitted = true;
      await finishSubscriptionSignIn(oauth, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (submitted) {
        oauthLoginIdRef.current = null;
        setOauth(null);
        void rpc("models/cancelOAuth", { loginId: oauth.loginId, reason: "interrupted" }).catch(
          () => undefined,
        );
      } else {
        retryable = true;
        setPasteCode(code);
      }
      publishFeedback("connection", {
        error: errorText(err, t`Could not finish sign-in`),
      });
    } finally {
      // A newer sign-in started by Start over owns the guard now; leave it alone.
      if (oauthAbortRef.current === controller) oauthCodeSubmittingRef.current = false;
      if (!retryable) {
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
    }
  }

  // Nothing asks the server about a code waiting to be pasted, so the card ends on the code's
  // own clock. A device code's expiry arrives with its status.
  useTimeout(
    () => {
      if (oauthCodeSubmittingRef.current) return;
      cancelOAuth("interrupted");
      publishFeedback("connection", { error: t`This code expired. Start again.` });
    },
    oauth?.mode === "auth-url" ? oauth.expiresInSeconds * 1000 : null,
    oauth?.loginId,
  );

  return {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    codeCopied,
    copyOAuthCode,
    cancelOAuth,
    leaveSignIn,
    openSignInPage,
    startSubscriptionSignIn,
    submitOAuthCode,
  };
}
