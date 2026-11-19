import { Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus, ComputerSize } from "@rakazo/contracts";
import { computerSizeLabel } from "@rakazo/i18n/computer-usage";
import { OptionSelect } from "@rakazo/ui-web/components/ui/option-select";
import { useSave, useSpaceQueries } from "../../lib/query/query";

export function ComputerSizeSetting({
  settings,
}: {
  settings: NonNullable<BillingStatus["computerSizeSettings"]>;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const change = useSave({
    stale: [queries.billing.status.key()],
    save: (size: ComputerSize, rpc) => rpc.billing.setComputerSize({ size }),
  });
  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-body">
          <Trans>Computer size</Trans>
        </span>
        <OptionSelect
          className="w-auto min-w-32"
          size="sm"
          aria-label={t`Computer size`}
          value={settings.size}
          options={settings.available.map((size) => ({
            value: size,
            label: computerSizeLabel(size, true),
          }))}
          onValueChange={change.run}
          disabled={change.pending}
        />
      </div>
      <p className="text-body text-muted-foreground">
        <Trans>Applies to this organization's computers on their next start.</Trans>
      </p>
      {change.error ? (
        <p className="text-body text-destructive" role="alert">
          <Trans>Could not change computer size</Trans>
        </p>
      ) : null}
    </div>
  );
}
