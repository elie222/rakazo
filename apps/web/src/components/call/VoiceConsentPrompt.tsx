import { Suspense, useEffect, useSyncExternalStore } from "react";
import {
  cancelVoiceConsent,
  pendingVoiceConsent,
  subscribeVoiceConsent,
} from "../../lib/calls/voice-consent";
import { lazyComponent } from "../../lib/platform/preload-recovery";

const VoiceConsentDialog = lazyComponent(() =>
  import("./VoiceConsentDialog").then((module) => module.VoiceConsentDialog),
);

export function VoiceConsentPrompt() {
  const request = useSyncExternalStore(subscribeVoiceConsent, pendingVoiceConsent, () => null);
  useEffect(() => cancelVoiceConsent, []);
  return request ? (
    <Suspense fallback={null}>
      <VoiceConsentDialog request={request} />
    </Suspense>
  ) : null;
}
