import { Suspense, useEffect, useSyncExternalStore } from "react";
import {
  cancelVoiceConsent,
  pendingVoiceConsent,
  subscribeVoiceConsent,
} from "../../lib/calls/voice-consent";
import { lazyComponent } from "../../lib/platform/preload-recovery";

const AiDataConsentDialog = lazyComponent(() =>
  import("./AiDataConsentDialog").then((module) => module.AiDataConsentDialog),
);

export function AiDataConsentPrompt() {
  const request = useSyncExternalStore(subscribeVoiceConsent, pendingVoiceConsent, () => null);
  useEffect(() => cancelVoiceConsent, []);
  return request ? (
    <Suspense fallback={null}>
      <AiDataConsentDialog request={request} />
    </Suspense>
  ) : null;
}
