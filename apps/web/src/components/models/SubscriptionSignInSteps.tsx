import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ModelCatalogEntry, ModelOAuthBegin } from "@rakazo/contracts";
import type { StepperStep } from "@rakazo/ui-web";
import { Button, buttonVariants, Input, Stepper } from "@rakazo/ui-web";
import { ArrowUpRight, Check } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Signing in with a subscription, one step at a time: any setting the provider needs turned on,
 * then starting the sign-in, then the code. The provider's page opens only from the user's
 * click, after the code it needs is on screen.
 */
export function SubscriptionSignInSteps({
  oauth,
  setup,
  startLabel,
  starting,
  disabled = starting,
  onStart,
  onRestart,
  codeCopied,
  onCopyCode,
  pasteCode,
  onPasteCodeChange,
  onSubmitCode,
  onPageOpened,
}: {
  oauth: ModelOAuthBegin | null;
  setup: ModelCatalogEntry["signInSetup"];
  startLabel: ReactNode;
  starting: boolean;
  /** Also while other work on the connection is saving. */
  disabled?: boolean;
  onStart: () => void;
  /** Drops the sign-in in progress and starts a new one, for a code that expired or was refused. */
  onRestart: () => void;
  codeCopied: boolean;
  onCopyCode: (code: string) => void;
  pasteCode: string;
  onPasteCodeChange: (code: string) => void;
  onSubmitCode: () => void;
  onPageOpened: () => void;
}) {
  const { t } = useLingui();
  const start = (
    <Button className="mt-2" disabled={disabled} onClick={onStart}>
      {starting ? <Trans>Starting…</Trans> : startLabel}
    </Button>
  );
  if (!oauth && !setup) return start;

  const setupStep: StepperStep[] = setup
    ? [
        {
          id: "setup",
          status: oauth ? "complete" : "current",
          title: setup.label,
          description: (
            <a
              href={setup.url}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "outline", className: "mt-2" })}
            >
              <Trans>Open settings</Trans>
              <ArrowUpRight aria-hidden="true" />
            </a>
          ),
        },
      ]
    : [];

  let steps: StepperStep[];
  if (!oauth) {
    steps = [
      ...setupStep,
      { id: "start", status: "upcoming", title: t`Get a sign-in code`, description: start },
    ];
  } else if (oauth.mode === "device-code") {
    const host = displayHost(oauth.verificationUri);
    steps = [
      ...setupStep,
      {
        id: "code",
        status: "current",
        title: <Trans>Enter this code at {host}</Trans>,
        description: (
          <>
            <span className="mt-1 block font-mono text-heading2 tracking-[0.2em] text-foreground">
              {oauth.userCode}
            </span>
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
              {codeCopied ? <Trans>Copied, open again</Trans> : <Trans>Copy code and open</Trans>}
            </a>
          </>
        ),
      },
      {
        id: "wait",
        status: "upcoming",
        busy: true,
        title: t`Waiting for you to sign in`,
        description: (
          <>
            <Plural
              value={Math.ceil(oauth.expiresInSeconds / 60)}
              one="The code expires in about # minute."
              other="The code expires in about # minutes."
            />{" "}
            <Button variant="text" size="sm" onClick={onRestart}>
              <Trans>Get a new code</Trans>
            </Button>
          </>
        ),
      },
    ];
  } else {
    const host = new URL(oauth.verificationUri).hostname;
    steps = [
      ...setupStep,
      {
        id: "open",
        status: "current",
        title: <Trans>Sign in at {host}</Trans>,
        description: (
          <a
            href={oauth.verificationUri}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ className: "mt-2" })}
            onClick={onPageOpened}
          >
            <Trans>Open {host}</Trans>
            <ArrowUpRight aria-hidden="true" />
          </a>
        ),
      },
      {
        id: "paste",
        status: "upcoming",
        title: t`Paste the code it shows you`,
        description: (
          <>
            <span className="mt-2 flex items-center gap-2">
              <Input
                value={pasteCode}
                onChange={(e) => onPasteCodeChange(e.target.value)}
                aria-label={t`Code from ${host}`}
                placeholder={t`Paste code`}
                autoComplete="off"
                spellCheck={false}
              />
              <Button variant="outline" disabled={!pasteCode.trim()} onClick={onSubmitCode}>
                <Trans>Submit</Trans>
              </Button>
            </span>
            <Button variant="text" size="sm" className="mt-2" onClick={onRestart}>
              <Trans>Start over</Trans>
            </Button>
          </>
        ),
      },
    ];
  }
  return <Stepper className="mt-2" steps={steps} completeLabel={t`Done`} />;
}

function displayHost(url: string) {
  return url.replace(/^https:\/\//, "").replace(/\/$/, "");
}
