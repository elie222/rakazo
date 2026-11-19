import { Trans, useLingui } from "@lingui/react/macro";
import { computerUsageDetails } from "@rakazo/i18n/computer-usage";
import { Disclosure } from "@rakazo/ui-web/components/ui/disclosure";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query/query";

export function ComputerUsage() {
  const { i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const queries = useSpaceQueries();
  const usage = useQuery({ ...queries.billing.computerUsage.queryOptions(), enabled: open });
  const { rows, message } = computerUsageDetails(usage, i18n.locale || "en");

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
              <dd className="shrink-0 text-muted-foreground tabular-nums">{row.hours}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-body text-muted-foreground" role="status">
          {message}
        </p>
      )}
    </Disclosure>
  );
}
