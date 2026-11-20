import { Trans } from "@lingui/react/macro";
import type { ModelCatalogEntry } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { ArrowUpRight } from "lucide-react";

/** The setting a provider needs turned on, shown before a sign-in starts its clock. */
export function SignInSetupStep({
  setup,
  disabled,
  onContinue,
  onCancel,
}: {
  setup: NonNullable<ModelCatalogEntry["signInSetup"]>;
  disabled?: boolean;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <a
        href={setup.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-body-sm text-foreground underline"
      >
        {setup.label}
        <ArrowUpRight size={14} aria-hidden="true" />
      </a>
      {setup.note ? <p className="mt-1 text-body-sm text-muted-foreground">{setup.note}</p> : null}
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" size="sm" disabled={disabled} onClick={onContinue}>
          <Trans>I’ve turned it on</Trans>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={onCancel}
        >
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </>
  );
}
