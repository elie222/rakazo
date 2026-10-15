import { Trans, useLingui } from "@lingui/react/macro";
import type { RunExecutionProfile } from "@rakazo/contracts";
import { EXECUTION_HARNESS_LABELS } from "@rakazo/contracts";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { Info } from "lucide-react";

/** Attribution comes from the run snapshot, never the bot’s current profile or account list. */
export function RunExecutionProfileDetails({ profile }: { profile?: RunExecutionProfile | null }) {
  const { t } = useLingui();
  if (!profile) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={t`Run details`} />}
      >
        <Info size={14} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-72" align="end">
        <p className="text-sm font-medium">
          <Trans>Run details</Trans>
        </p>
        <dl className="space-y-1 text-[13px]">
          {[
            [t`Execution profile`, `${profile.name} · v${profile.revision}`],
            [t`Harness`, EXECUTION_HARNESS_LABELS[profile.harness]],
            [t`Provider`, profile.provider],
            [t`Model`, profile.modelId],
            [t`Account`, profile.accountLabel],
          ].map(([label, value]) => (
            <div key={label} className="flex gap-3">
              <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
