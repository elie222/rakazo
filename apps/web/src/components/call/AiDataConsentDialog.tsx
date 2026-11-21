import { Trans, useLingui } from "@lingui/react/macro";
import { AI_PRIVACY_URL } from "@rakazo/contracts";
import { pageRevisionDataDisclosure } from "@rakazo/i18n/page-review";
import type { VoiceConsentRequest } from "../../lib/calls/voice-consent";
import { ConfirmDialog } from "../ConfirmDialog";

export function AiDataConsentDialog({ request }: { request: VoiceConsentRequest }) {
  const { t } = useLingui();
  const name = request.recipient.name;
  return (
    <ConfirmDialog
      title={
        request.recipient.use === "model"
          ? t`Share data with ${name}?`
          : t`Share voice data with ${name}?`
      }
      description={
        <>
          {request.recipient.detail ? (
            <span className="mb-2 block break-words">{request.recipient.detail}</span>
          ) : null}
          {request.recipient.use === "model" ? (
            pageRevisionDataDisclosure()
          ) : (
            <Trans>
              Your recordings are sent for transcription, and text you play is sent to generate
              speech.
            </Trans>
          )}
        </>
      }
      confirmLabel={t`Allow`}
      variant="default"
      onConfirm={() => request.finish(true)}
      onCancel={() => request.finish(false)}
    >
      <a
        className="text-body text-muted-foreground underline underline-offset-4"
        href={request.recipient.privacyUrl ?? request.privacyUrl ?? AI_PRIVACY_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Trans>Privacy policy</Trans>
      </a>
    </ConfirmDialog>
  );
}
