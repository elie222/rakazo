import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus } from "@rakazo/contracts";
import { billingNote, cancelPlanOffered, isNoPlanToCancel } from "@rakazo/contracts";
import { Button, SectionHeading, Skeleton } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { ModelCreditsSettings } from "../components/ModelCredits";
import { billingDateLabel, formatBillingPrice } from "../lib/billing";
import { useSave } from "../lib/query";
import type { RpcClient } from "../lib/rpc";

/** `client` is the window's space: another tab can select another organization at any time. */
export function BillingSettingsPanel({ client }: { client: RpcClient }) {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || "en";
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Desktop opens the URL in the system browser and this page stays, so the button comes back.
  const portal = useSave({
    save: (_: void, rpc) => rpc.billing.portal(),
    onSaved: ({ url }) => window.location.assign(url),
  });
  const cancel = useSave({
    save: async (_: void, rpc) => {
      try {
        return await rpc.billing.portal({ intent: "cancel" });
      } catch (err) {
        // The server found no plan to cancel: show the status it just read, so the button goes
        // instead of failing again. Any other refusal, busy billing included, is not it.
        if (!isNoPlanToCancel(err)) throw err;
        setStatus(await rpc.billing.status());
        return null;
      }
    },
    onSaved: (opened) => {
      if (opened) window.location.assign(opened.url);
    },
  });

  useEffect(() => {
    let active = true;
    client.billing
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
  }, [client, t]);

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

  const cancelOffered = status ? cancelPlanOffered(status) : null;
  const note = status ? billingNote(status) : null;
  const busy = portal.pending || cancel.pending;

  const price = status?.price ? formatBillingPrice(status.price, locale) : null;
  const seats = status?.seats ?? 0;

  if (status?.funding !== undefined)
    return (
      <ModelCreditsSettings
        status={status}
        refresh={async () => setStatus(await client.billing.status())}
        client={client}
      />
    );

  return (
    <div data-testid="billing-settings" className="rounded-xl border border-border px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {status ? (
            <SectionHeading variant="heading">{stateLabel}</SectionHeading>
          ) : error ? null : (
            <Skeleton className="h-5 w-24" />
          )}
          {price ? (
            <p className="mt-3 flex flex-wrap gap-x-2 text-body text-foreground/75">
              <span>{price}</span>
              {seats > 1 ? (
                <span className="text-muted-foreground">
                  <Plural value={seats} one="# seat" other="# seats" />
                </span>
              ) : null}
            </p>
          ) : null}
          {dateLabel ? (
            <p className="mt-2 text-body-sm text-muted-foreground/80">{dateLabel}</p>
          ) : null}
        </div>
        {status?.canManage && status.hasCustomer ? (
          <div className="flex shrink-0 items-center gap-2">
            {cancelOffered ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  portal.reset();
                  cancel.run();
                }}
              >
                {cancelOffered === "trial" ? (
                  <Trans>Cancel trial</Trans>
                ) : (
                  <Trans>Cancel plan</Trans>
                )}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setError(null);
                cancel.reset();
                portal.run();
              }}
            >
              <Trans>Manage</Trans>
            </Button>
          </div>
        ) : null}
      </div>
      {note ? (
        <p className="mt-3 text-body text-muted-foreground">
          {note === "owner_only" ? (
            <Trans>Only the organization owner can change or cancel billing.</Trans>
          ) : (
            <Trans>No payment method on file. Nothing will be charged.</Trans>
          )}
        </p>
      ) : null}
      {portal.error || cancel.error || error ? (
        <p role="alert" className="mt-3 text-body text-destructive">
          {portal.error || cancel.error ? t`Could not open billing` : error}
        </p>
      ) : null}
    </div>
  );
}
