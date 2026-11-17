import { t } from "@lingui/core/macro";
import type { AiRecipient, SettingsScope } from "@rakazo/contracts";
import { ensureAiDataConsent } from "@rakazo/core";
import { createSpaceRpc } from "../query/rpc";

export type VoiceConsentRequest = {
  recipient: AiRecipient;
  privacyUrl?: string;
  finish(allowed: boolean): void;
};
let requests: VoiceConsentRequest[] = [];
const allowedUntil = new Map<string, number>();
const CONSENT_CACHE_MS = 30_000;
let consentGeneration = 0;
let requestSerial = 0;

export function invalidateVoiceConsent() {
  allowedUntil.clear();
  consentGeneration += 1;
}
const watchers = new Set<() => void>();
function emit() {
  for (const watcher of watchers) watcher();
}
export function subscribeVoiceConsent(watcher: () => void) {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}
export const pendingVoiceConsent = () => requests[0] ?? null;
export function cancelVoiceConsent() {
  invalidateVoiceConsent();
  for (const request of [...requests]) request.finish(false);
}
function prompt(
  recipient: AiRecipient,
  privacyUrl?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const cancel = () => request.finish(false);
    const request: VoiceConsentRequest = {
      recipient,
      privacyUrl,
      finish(allowed) {
        if (!requests.includes(request)) return;
        requests = requests.filter((item) => item !== request);
        signal?.removeEventListener("abort", cancel);
        resolve(allowed);
        emit();
      },
    };
    requests = [...requests, request];
    signal?.addEventListener("abort", cancel, { once: true });
    emit();
  });
}

/** Pin disclosure and its grant to the same Space as the pending speech request. */
export async function ensureVoiceConsent(
  spaceId: string | null,
  scope?: SettingsScope,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const key = JSON.stringify([spaceId, scope]);
  if ((allowedUntil.get(key) ?? 0) > Date.now()) return;
  const generation = consentGeneration;
  const client = createSpaceRpc(spaceId);
  await ensureAiDataConsent({
    uses: ["voice"],
    status: () =>
      client.aiConsent.status(
        { uses: ["voice"], ...(scope ? { settingsScope: scope } : {}) },
        { signal },
      ),
    prompt: async (recipient, privacyUrl) => {
      if (!(await prompt(recipient, privacyUrl, signal)))
        throw new Error(t`Voice data sharing was not allowed.`);
      return true;
    },
    allow: (input) => {
      signal?.throwIfAborted();
      return client.aiConsent.allow({ ...input, ...(scope ? { settingsScope: scope } : {}) });
    },
    coalesceKey: JSON.stringify([spaceId, scope, signal ? ++requestSerial : null]),
  });
  signal?.throwIfAborted();
  if (generation === consentGeneration) allowedUntil.set(key, Date.now() + CONSENT_CACHE_MS);
}
