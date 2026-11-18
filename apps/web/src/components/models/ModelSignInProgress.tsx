import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ModelOAuthBegin } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";

/** A subscription sign-in in progress: the link and code to finish it, or the code to paste. */
export function ModelSignInProgress({
  oauth,
  pasteCode,
  setPasteCode,
  submitOAuthCode,
  popupBlocked,
  codeCopied,
  copyOAuthCode,
  cancelOAuthAttempt,
  onPageOpened,
}: {
  oauth: ModelOAuthBegin;
  pasteCode: string;
  setPasteCode: (code: string) => void;
  submitOAuthCode: () => Promise<void>;
  popupBlocked: boolean;
  codeCopied: boolean;
  copyOAuthCode: (text: string) => unknown;
  cancelOAuthAttempt: () => void;
  /** The user opened the provider's sign-in page from a link here. */
  onPageOpened: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="w-full rounded-xl border border-border px-4 py-3">
      {oauth.mode === "auth-url" ? (
        <>
          <p className="text-body-sm leading-[1.5] text-muted-foreground">
            <Trans>
              Sign in at{" "}
              <a
                href={oauth.verificationUri}
                onClick={onPageOpened}
                target="_blank"
                rel="noreferrer"
                className="text-foreground underline"
              >
                {new URL(oauth.verificationUri).hostname}
              </a>
              , then paste the code here.
            </Trans>
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Input
              value={pasteCode}
              onChange={(e) => setPasteCode(e.target.value)}
              aria-label={t`Authorization code`}
              autoComplete="off"
              spellCheck={false}
              className="text-foreground md:text-body-sm"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!pasteCode.trim()}
              onClick={() => void submitOAuthCode()}
            >
              <Trans>Submit</Trans>
            </Button>
          </div>
          <p className="mt-2 text-body-sm leading-[1.5] text-muted-foreground">
            <Plural
              value={Math.ceil(oauth.expiresInSeconds / 60)}
              one="Waiting for sign-in — the link expires in about # minute."
              other="Waiting for sign-in — the link expires in about # minutes."
            />
          </p>
        </>
      ) : (
        <>
          <p className="text-body-sm leading-[1.5] text-muted-foreground">
            {popupBlocked ? (
              <Trans>
                Open{" "}
                <a
                  href={oauth.verificationUri}
                  onClick={onPageOpened}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline"
                >
                  {oauth.verificationUri.replace(/^https:\/\//, "")}
                </a>{" "}
                and enter this code:
              </Trans>
            ) : (
              <Trans>
                A sign-in tab opened at{" "}
                <a
                  href={oauth.verificationUri}
                  onClick={onPageOpened}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline"
                >
                  {oauth.verificationUri.replace(/^https:\/\//, "")}
                </a>
                . Enter this code there — this window keeps waiting:
              </Trans>
            )}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <p className="font-mono text-heading2 tracking-[0.2em] text-foreground">
              {oauth.userCode}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copyOAuthCode(oauth.userCode)}
            >
              {codeCopied ? (
                <Check size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
              {codeCopied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
            </Button>
          </div>
          <p className="mt-2 text-body-sm leading-[1.5] text-muted-foreground">
            <Plural
              value={Math.ceil(oauth.expiresInSeconds / 60)}
              one="Waiting for sign-in — the code expires in about # minute."
              other="Waiting for sign-in — the code expires in about # minutes."
            />
          </p>
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-2 -ml-2 text-muted-foreground"
        onClick={() => cancelOAuthAttempt()}
      >
        <Trans>Cancel</Trans>
      </Button>
    </div>
  );
}
