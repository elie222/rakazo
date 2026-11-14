import { useLingui } from "@lingui/react/macro";
import type { ModelOAuthBegin, ThinkingLevel } from "@rakazo/contracts";
import { clampCatalogThinkingLevel } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import type { RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import { Linking } from "react-native";
import type { rpc as apiRpc } from "./api";
import type { MobileModel, MobileModelCredential } from "./mobile-types";
import { cancelModelOAuthAttempt, finishModelOAuthAttempt, waitForModelOAuth } from "./model-auth";
import type { SettingsTarget } from "./settings-target";
import { errorText } from "./user-error";

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

  const copyOAuthCode = useCallback((code: string) => {
    void Clipboard.setStringAsync(code)
      .then(() => {
        setCodeCopied(true);
        if (codeCopiedTimerRef.current) clearTimeout(codeCopiedTimerRef.current);
        codeCopiedTimerRef.current = setTimeout(() => setCodeCopied(false), 1600);
      })
      .catch(() => undefined);
  }, []);

  const cancelOAuth = useCallback(() => {
    const loginId = oauthLoginIdRef.current;
    oauthLoginIdRef.current = null;
    cancelModelOAuthAttempt(oauthAbortRef, () => {
      setOauth(null);
      setOauthPending(false);
    });
    if (loginId) void rpc("models/cancelOAuth", { loginId }).catch(() => undefined);
  }, [rpc]);

  /** Cancels a sign-in in progress and the pending reset of the Copied label. */
  const cancelSignIn = useCallback(() => {
    cancelOAuth();
    if (codeCopiedTimerRef.current) clearTimeout(codeCopiedTimerRef.current);
  }, [cancelOAuth]);

  async function finishSubscriptionSignIn(loginId: string, controller: AbortController) {
    await waitForModelOAuth(loginId, controller.signal, rpc);
    if (controller.signal.aborted) return;
    const saved = await rpc("models/finishOAuth", { loginId }, { signal: controller.signal });
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
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      oauthLoginIdRef.current = started.loginId;
      setPasteCode("");
      setOauth(started);
      await Linking.openURL(started.verificationUri);
      waitingForCode = started.mode === "auth-url";
      if (!waitingForCode) await finishSubscriptionSignIn(started.loginId, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      const loginId = oauthLoginIdRef.current;
      oauthLoginIdRef.current = null;
      if (loginId) void rpc("models/cancelOAuth", { loginId }).catch(() => undefined);
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
      await finishSubscriptionSignIn(oauth.loginId, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (submitted) {
        oauthLoginIdRef.current = null;
        setOauth(null);
        void rpc("models/cancelOAuth", { loginId: oauth.loginId }).catch(() => undefined);
      } else {
        retryable = true;
        setPasteCode(code);
      }
      publishFeedback("connection", {
        error: errorText(err, t`Could not finish sign-in`),
      });
    } finally {
      oauthCodeSubmittingRef.current = false;
      if (!retryable) {
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPending(false));
      }
    }
  }

  return {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    codeCopied,
    copyOAuthCode,
    cancelOAuth,
    cancelSignIn,
    startSubscriptionSignIn,
    submitOAuthCode,
  };
}
