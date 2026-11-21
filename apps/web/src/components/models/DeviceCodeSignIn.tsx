import { Plural, Trans } from "@lingui/react/macro";
import type { ModelCatalogEntry, ModelOAuthBegin } from "@rakazo/contracts";
import { buttonVariants } from "@rakazo/ui-web";
import { ArrowUpRight, Check } from "lucide-react";
import type { ReactNode } from "react";

/** The code first, then the page to enter it on, so the user never lands there without it. */
export function DeviceCodeSignIn({
  oauth,
  setup,
  codeCopied,
  onCopyCode,
  onPageOpened,
}: {
  oauth: Extract<ModelOAuthBegin, { mode: "device-code" }>;
  setup: ModelCatalogEntry["signInSetup"];
  codeCopied: boolean;
  onCopyCode: (code: string) => void;
  onPageOpened: () => void;
}) {
  const host = oauth.verificationUri.replace(/^https:\/\//, "").replace(/\/$/, "");
  const enterCode = (
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
    </>
  );
  return (
    <>
      {setup ? (
        <ol className="grid gap-4">
          <Step number={1}>
            <a
              href={setup.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-body-sm text-foreground underline"
            >
              {setup.label}
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          </Step>
          <Step number={2}>{enterCode}</Step>
        </ol>
      ) : (
        enterCode
      )}
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

function Step({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-label text-muted-foreground"
      >
        {number}
      </span>
      <div className="min-w-0">{children}</div>
    </li>
  );
}
