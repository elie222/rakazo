import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus } from "@rakazo/contracts";
import { Button, Skeleton } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { ModelCreditsSettings } from "../components/ModelCredits";
import { billingDateLabel, formatBillingPrice } from "../lib/billing";
import { rpc } from "../lib/rpc";

export function BillingSettingsPanel() {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || "en";
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    rpc.billing
      .status()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setError(t`Could not load billing`);
      });
    return () => {
      active = false;
    };
  }, [t]);

  async function openPortal() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const { url } = await rpc.billing.portal();
      window.location.assign(url);
    } catch {
      setError(t`Could not open billing`);
    } finally {
      // Desktop opens the URL in the system browser and this page stays, so re-enable.
      setPending(false);
    }
  }

  const stateLabel = status
    ? status.state === "trialing"
      ? t`Trial`
      : status.state === "active"
        ? t`Active`
        : status.state === "past_due"
          ? t`Past due`
          : status.state === "canceled"
            ? t`Canceled`
            : t`Inactive`
    : null;

  const dateLabel = status ? billingDateLabel(status, locale) : null;

  const price = status?.price ? formatBillingPrice(status.price, locale) : null;
  const seats = status?.seats ?? 0;

  if (status?.funding !== undefined)
    return (
      <ModelCreditsSettings
        status={status}
        refresh={async () => setStatus(await rpc.billing.status())}
      />
    );

  return (
    <div data-testid="billing-settings" className="rounded-xl border border-border px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {status ? (
            <h3 className="text-heading3 font-medium text-foreground">{stateLabel}</h3>
          ) : error ? null : (
            <Skeleton className="h-5 w-24" />
          )}
          {price ? (
            <p className="mt-3 flex flex-wrap gap-x-2 text-[14px] text-foreground/75">
              <span>{price}</span>
              {seats > 1 ? (
                <span className="text-muted-foreground">
                  <Plural value={seats} one="# seat" other="# seats" />
                </span>
              ) : null}
            </p>
          ) : null}
          {dateLabel ? (
            <p className="mt-2 text-[12.5px] text-muted-foreground/80">{dateLabel}</p>
          ) : null}
        </div>
        {status?.canManage && status.hasCustomer ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => void openPortal()}
          >
            <Trans>Manage</Trans>
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
