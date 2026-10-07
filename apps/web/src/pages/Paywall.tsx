import { Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth";
import { formatBillingPrice } from "../lib/billing";
import { clearSpaceSelection, rpc } from "../lib/rpc";
import { AuthFrame, submitClass } from "./Auth";

export function PaywallPage({ status }: { status: BillingStatus }) {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showPortal =
    status.canManage &&
    status.hasCustomer &&
    (status.state === "past_due" || status.state === "incomplete" || status.state === "canceled");

  async function open(target: "checkout" | "portal") {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const { url } = await (target === "checkout" ? rpc.billing.checkout() : rpc.billing.portal());
      window.location.assign(url);
    } catch {
      setError(t`Could not open billing`);
    } finally {
      // Desktop opens the URL in the system browser and this page stays, so re-enable.
      setPending(false);
    }
  }

  const trialDays = status.trialDays;
  const included = [
    t`Bots with their own computer and browser`,
    t`Routines that run while you're away`,
    t`Any model, with your own key`,
    t`Web, desktop and mobile apps`,
  ];
  const title =
    status.canManage && status.price
      ? formatBillingPrice(status.price, i18n.locale || "en")
      : t`Subscription required`;

  return (
    <AuthFrame
      title={title}
      onSubmit={(event) => {
        event.preventDefault();
        if (status.canManage) void open("checkout");
      }}
    >
      <div data-testid="billing-paywall" className="flex w-full flex-col items-center">
        {error ? (
          <p role="alert" className="mb-3 w-full text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {status.canManage ? (
          <ul className="mb-9 flex flex-col gap-3 text-base">
            {included.map((item) => (
              <li key={item} className="flex items-center gap-3">
                <Check aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                {item}
              </li>
            ))}
          </ul>
        ) : null}
        {status.canManage ? (
          <Button type="submit" size="lg" disabled={pending} className={submitClass}>
            {status.trialAvailable ? (
              <Trans>Start {trialDays}-day free trial</Trans>
            ) : (
              <Trans>Subscribe</Trans>
            )}
          </Button>
        ) : null}
        {showPortal ? (
          <Button
            type="button"
            size="lg"
            variant="secondary"
            disabled={pending}
            className={submitClass}
            onClick={() => void open("portal")}
          >
            <Trans>Manage billing</Trans>
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="mt-6 text-muted-foreground"
          onClick={() =>
            void authClient.signOut().then(() => {
              clearSpaceSelection();
              navigate("/");
            })
          }
        >
          <Trans>Log out</Trans>
        </Button>
      </div>
    </AuthFrame>
  );
}
