import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelOAuthBegin } from "@rakazo/contracts";
import { Button, buttonVariants, Input } from "@rakazo/ui-web";
import { ArrowUpRight } from "lucide-react";

/** A sign-in page that shows a code to paste back. The page opens from the user's click, which no popup blocker stops. */
export function PasteCodeSignIn({
  oauth,
  code,
  onCodeChange,
  onSubmit,
  onPageOpened,
}: {
  oauth: Extract<ModelOAuthBegin, { mode: "auth-url" }>;
  code: string;
  onCodeChange: (code: string) => void;
  onSubmit: () => void;
  onPageOpened: () => void;
}) {
  const { t } = useLingui();
  const host = new URL(oauth.verificationUri).hostname;
  return (
    <>
      <p className="text-body-sm text-muted-foreground">
        <Trans>Sign in at {host}, then paste the code it shows you here.</Trans>
      </p>
      <a
        href={oauth.verificationUri}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ className: "mt-3" })}
        onClick={onPageOpened}
      >
        <Trans>Open {host}</Trans>
        <ArrowUpRight aria-hidden="true" />
      </a>
      <div className="mt-3 flex items-center gap-2">
        <Input
          value={code}
          onChange={(e) => onCodeChange(e.target.value)}
          aria-label={t`Code from ${host}`}
          placeholder={t`Paste code`}
          autoComplete="off"
          spellCheck={false}
        />
        <Button variant="outline" disabled={!code.trim()} onClick={onSubmit}>
          <Trans>Submit</Trans>
        </Button>
      </div>
    </>
  );
}
