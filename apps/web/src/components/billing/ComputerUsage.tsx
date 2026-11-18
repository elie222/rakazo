import { Trans, useLingui } from "@lingui/react/macro";
import { Disclosure } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query/query";

export function ComputerUsage() {
  const { i18n, t } = useLingui();
  const [open, setOpen] = useState(false);
  const queries = useSpaceQueries();
  const usage = useQuery({ ...queries.billing.computerUsage.queryOptions(), enabled: open });
  const hours = new Intl.NumberFormat(i18n.locale || "en", {
    style: "unit",
    unit: "hour",
    maximumFractionDigits: 1,
  });
  const rows =
    usage.data?.computers.map((computer) => ({
      id: computer.id,
      label:
        computer.scope === "team" ? t`Team Computer` : (computer.botName ?? t`Private Computer`),
      hours: computer.hours,
    })) ?? [];
  if (usage.data && usage.data.otherHours > 0) {
    rows.push({ id: "other", label: t`Other computers`, hours: usage.data.otherHours });
  }

  return (
    <Disclosure
      className="mt-3"
      summaryClassName="text-body"
      summary={<Trans>Hours by computer</Trans>}
      open={open}
      onOpenChange={setOpen}
    >
      {rows.length > 0 ? (
        <dl className="mt-2 divide-y divide-border text-body">
          {rows.map((row) => (
            <div key={row.id} className="flex justify-between gap-4 py-2">
              <dt className="min-w-0 break-words">{row.label}</dt>
              <dd className="shrink-0 text-muted-foreground tabular-nums">
                {hours.format(row.hours)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-body text-muted-foreground" role="status">
          {usage.isError
            ? t`Could not load computer hours`
            : usage.data
              ? t`No computer hours used yet`
              : t`Loading…`}
        </p>
      )}
    </Disclosure>
  );
}
