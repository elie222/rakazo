import { Trans, useLingui } from "@lingui/react/macro";
import type { CloudComputers, ComputerSize } from "@rakazo/contracts";
import { ComputerSizeSchema, computerSizeChoice } from "@rakazo/contracts";
import { computerName, computerSizeLabel } from "@rakazo/i18n/computer-usage";
import { Button, OptionSelect } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { SettingsGroup, SettingsRow } from "../settings/SettingsRows";

export function useCloudComputers() {
  return useQuery(useSpaceQueries().cloudComputers.list.queryOptions());
}

/** Each of the Space's cloud computers with the size it starts at next. */
export function CloudComputerSizes({ onUpgrade }: { onUpgrade?: () => void }) {
  const { data, error, isFetching, refetch } = useCloudComputers();
  if (!data && error) {
    return (
      <SettingsGroup title={<Trans>Cloud computers</Trans>} data-testid="cloud-computers">
        <SettingsRow
          label={
            <p className="text-destructive" role="alert">
              <Trans>Could not load</Trans>
            </p>
          }
          control={
            <Button
              variant="secondary"
              size="sm"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              <Trans>Retry</Trans>
            </Button>
          }
        />
      </SettingsGroup>
    );
  }
  if (!data?.computers.length) return null;
  return (
    <SettingsGroup title={<Trans>Cloud computers</Trans>} data-testid="cloud-computers">
      {data.computers.map((computer) => (
        <CloudComputerRow
          key={computer.id}
          computer={computer}
          available={data.available}
          canManage={data.canManage}
          onUpgrade={onUpgrade}
        />
      ))}
    </SettingsGroup>
  );
}

function CloudComputerRow({
  computer,
  available,
  canManage,
  onUpgrade,
}: {
  computer: CloudComputers["computers"][number];
  available: readonly ComputerSize[];
  canManage: boolean;
  onUpgrade?: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  // A size above the plan is chosen only to see that it needs an upgrade; nothing is saved.
  const [beyondPlan, setBeyondPlan] = useState<ComputerSize | null>(null);
  const [changed, setChanged] = useState(false);
  const change = useSave({
    stale: [queries.cloudComputers.list.key()],
    save: (size: ComputerSize, rpc) =>
      rpc.cloudComputers.setSize({ computerId: computer.id, size }),
    onSaved: () => setChanged(true),
  });
  const name = computerName(computer);
  // A plan that grew to include the size chosen above it no longer needs the upgrade prompt.
  const overPlan = beyondPlan && !available.includes(beyondPlan) ? beyondPlan : null;
  const shown = overPlan ?? (change.pending ? change.input : undefined) ?? computer.size;

  return (
    <SettingsRow
      label={<p className="break-words">{name}</p>}
      control={
        canManage ? (
          <OptionSelect
            className="w-auto min-w-32 shrink-0"
            size="sm"
            aria-label={t`Size of ${name}`}
            data-testid={`computer-size-${computer.id}`}
            value={shown}
            options={ComputerSizeSchema.options.map((size) => ({
              value: size,
              label: computerSizeLabel(size),
            }))}
            disabled={change.pending}
            onValueChange={(size) => {
              change.reset();
              setChanged(false);
              const choice = computerSizeChoice(size, computer, available);
              setBeyondPlan(choice === "upgrade" ? size : null);
              if (choice === "save") change.run(size);
            }}
          />
        ) : (
          <span className="text-body text-muted-foreground">
            {computerSizeLabel(computer.size)}
          </span>
        )
      }
    >
      {overPlan ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-body-sm text-muted-foreground">
            <Trans>Your plan does not include this size.</Trans>
          </p>
          {onUpgrade ? (
            <Button variant="secondary" size="sm" onClick={onUpgrade}>
              <Trans>Upgrade</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      {changed ? (
        <p className="mt-2 text-body-sm text-muted-foreground" role="status">
          <Trans>Applies on its next start.</Trans>
        </p>
      ) : null}
      {change.error ? (
        <p className="mt-2 text-body-sm text-destructive" role="alert">
          <Trans>Could not change computer size</Trans>
        </p>
      ) : null}
    </SettingsRow>
  );
}
