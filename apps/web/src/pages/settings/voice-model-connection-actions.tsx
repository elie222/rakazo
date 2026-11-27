import { useLingui } from "@lingui/react/macro";
import type { VoiceCatalogEntry } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { SubscriptionSignInSteps } from "../../components/models/SubscriptionSignInSteps";
import { useCopyText } from "../../lib/copy-text";
import type { useModelOAuthSignIn } from "../../lib/models/use-model-oauth-signin";

export function VoiceModelConnectionActions({
  provider,
  choices,
  signInLabel,
  linked,
  disabled,
  signIn,
  onChoose,
}: {
  provider: string;
  choices: NonNullable<VoiceCatalogEntry["modelConnections"]>;
  signInLabel?: string;
  linked: boolean;
  disabled: boolean;
  signIn: ReturnType<typeof useModelOAuthSignIn>;
  onChoose: (credentialId: string) => Promise<boolean>;
}) {
  const { t } = useLingui();
  const [codeCopied, copyOAuthCode] = useCopyText();

  function start() {
    void signIn.startSubscriptionSignIn({ provider, credentialId: null, makeDefault: false });
  }

  if (signInLabel) {
    return (
      <div className="mt-5">
        <SubscriptionSignInSteps
          oauth={signIn.oauth}
          setup={undefined}
          startLabel={signInLabel}
          starting={signIn.oauthPending}
          disabled={disabled}
          onStart={start}
          onRestart={() => {
            signIn.cancelOAuthAttempt("replaced");
            start();
          }}
          codeCopied={codeCopied}
          onCopyCode={copyOAuthCode}
          pasteCode={signIn.pasteCode}
          submittingCode={signIn.submittingCode}
          onPasteCodeChange={signIn.setPasteCode}
          onSubmitCode={() => void signIn.submitOAuthCode()}
          onPageOpened={() => signIn.reportSignInStep("page_opened")}
        />
      </div>
    );
  }
  if (!choices.length) return null;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      {choices.map(({ id, label }) => (
        <Button
          key={id}
          type="button"
          variant={choices.length === 1 && !linked ? "default" : "outline"}
          disabled={disabled}
          onClick={() => void onChoose(id)}
        >
          {t`Use ${label}`}
        </Button>
      ))}
    </div>
  );
}
