import { Plural, Trans } from "@lingui/react/macro";
import type { ModelOAuthBegin } from "@rakazo/contracts";
import { buttonVariants } from "@rakazo/ui-web";
import { Check } from "lucide-react";

/** The code first, then the page to enter it on, so the user never lands there without it. */
export function DeviceCodeSignIn({
  oauth,
  codeCopied,
  onCopyCode,
  onPageOpened,
}: {
  oauth: Extract<ModelOAuthBegin, { mode: "device-code" }>;
  codeCopied: boolean;
  onCopyCode: (code: string) => void;
  onPageOpened: () => void;
}) {
  const host = oauth.verificationUri.replace(/^https:\/\//, "").replace(/\/$/, "");
  return (
    <>
      <p className="text-body-sm text-muted-foreground">
        <Trans>Enter this code at {host}</Trans>
      </p>
      <p className="mt-1 font-mono text-heading2 tracking-[0.2em] text-foreground">
        {oauth.userCode}
      </p>
      <a
        href={oauth.verificationUri}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ className: "mt-3" })}
        onClick={() => {
          onCopyCode(oauth.userCode);
          onPageOpened();
        }}
      >
        {codeCopied ? <Check aria-hidden="true" /> : null}
        {codeCopied ? <Trans>Code copied, open again</Trans> : <Trans>Copy code and open</Trans>}
      </a>
      <p className="mt-3 text-body-sm text-muted-foreground">
        <Plural
          value={Math.ceil(oauth.expiresInSeconds / 60)}
          one="Waiting for sign-in — the code expires in about # minute."
          other="Waiting for sign-in — the code expires in about # minutes."
        />
      </p>
    </>
  );
}
