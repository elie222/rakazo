import { Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus } from "@rakazo/contracts";
import {
  DEFAULT_MONTHLY_CREDIT_AMOUNT,
  MODEL_CREDIT_AMOUNTS,
  ModelCreditAmountSchema,
} from "@rakazo/contracts";
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatBillingAmount, formatBillingDate, formatBillingPrice } from "../lib/billing";
import { rpc } from "../lib/rpc";
import { useSignOut } from "../lib/sign-out";

type CreditAmount = (typeof MODEL_CREDIT_AMOUNTS)[number];

function formatMonthlyUsd(cents: number, locale: string): string {
  return formatBillingPrice(
    { amount: cents, currency: "usd", interval: "month", intervalCount: 1 },
    locale,
  );
}

export function CreditAmountSelect({
  value,
  onChange,
  monthly = false,
}: {
  value: CreditAmount;
  onChange: (amount: CreditAmount) => void;
  monthly?: boolean;
}) {
  const { t, i18n } = useLingui();
  const items = MODEL_CREDIT_AMOUNTS.map((amount) => ({
    value: amount,
    label: monthly
      ? formatMonthlyUsd(amount, i18n.locale)
      : formatBillingAmount(amount, "usd", i18n.locale),
  }));
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(ModelCreditAmountSchema.parse(next));
      }}
      items={items}
    >
      <SelectTrigger
        aria-label={monthly ? t`Monthly credits` : t`Credit amount`}
        className="w-full rounded-xl pr-3 pl-4 text-base data-[size=default]:h-12"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} className="py-2 text-base">
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function CreditChoice({
  status,
  dismissible = false,
}: {
  status: BillingStatus;
  dismissible?: boolean;
}) {
  const { t, i18n } = useLingui();
  const features = [
    t`Bots and browser automation`,
    t`Scheduled routines`,
    t`Web, desktop and mobile`,
  ];
  const trialDays = status.trialDays;
  const [amount, setAmount] = useState<CreditAmount>(DEFAULT_MONTHLY_CREDIT_AMOUNT);
  const credit = formatBillingAmount(amount, "usd", i18n.locale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const { logOut, signingOut } = useSignOut("/sign-in", () => setError(true));
  // A choice that answers after the plans were closed must not leave the app.
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);
  function go(url: string) {
    if (!closed.current) window.location.assign(url);
  }
  async function choose(ownKey: boolean) {
    setPending(true);
    setError(false);
    try {
      if (ownKey && status.byokFreeUntil) {
        go((await rpc.billing.checkout()).url);
      } else if (ownKey) {
        const { url } = await rpc.billing.selectFunding({ funding: "byok" });
        go(url ?? "/onboarding");
      } else {
        const { url } = await rpc.billing.purchaseCredits({
          amountCents: amount,
          monthly: true,
        });
        go(url);
      }
    } catch {
      setError(true);
      setPending(false);
    }
  }
  return (
    <div
      data-testid="billing-paywall"
      className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-8 px-6 py-12"
    >
      {dismissible ? null : (
        <Button
          className="fixed top-4 right-6"
          variant="text"
          disabled={pending || signingOut}
          onClick={() => void logOut()}
        >
          <Trans>Log out</Trans>
        </Button>
      )}
      <h1 className="text-heading1 font-medium">
        <Trans>Choose how to use Rakazo</Trans>
      </h1>
      <div className="grid gap-4 min-[480px]:grid-cols-2">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-medium">
              <Trans>Your subscription or API key</Trans>
            </h2>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4">
            <p className="flex h-12 items-center text-3xl font-medium tracking-tight">
              {status.byokPriceCents ? (
                formatMonthlyUsd(status.byokPriceCents, i18n.locale)
              ) : (
                <Trans>Free</Trans>
              )}
            </p>
            <p className="text-sm text-muted-foreground">
              <Trans>Works with your ChatGPT or Claude plan.</Trans>
            </p>
            <ul className="space-y-3 text-sm">
              {features.map((feature) => (
                <li key={feature} className="flex gap-2">
                  <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </CardContent>
          <CardFooter className="border-t-0 bg-transparent">
            <Button
              className="w-full bg-background dark:bg-transparent"
              variant="outline"
              disabled={pending || !status.canManage}
              aria-label={
                status.byokPriceCents && !status.trialAvailable
                  ? t`Subscribe with your own AI`
                  : undefined
              }
              onClick={() => void choose(true)}
            >
              {!status.byokPriceCents ? (
                <Trans>Connect my own</Trans>
              ) : status.trialAvailable ? (
                <Trans>Start {trialDays}-day free trial</Trans>
              ) : (
                <Trans>Subscribe</Trans>
              )}
            </Button>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <h2 className="text-lg font-medium">
              <Trans>Rakazo credits</Trans>
            </h2>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4">
            <CreditAmountSelect monthly value={amount} onChange={setAmount} />
            <p className="text-sm text-muted-foreground">
              <Trans>All {credit} goes to model usage.</Trans>
            </p>
            <ul className="space-y-3 text-sm">
              {[...features, t`Models at provider cost`].map((feature) => (
                <li key={feature} className="flex gap-2">
                  <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </CardContent>
          <CardFooter className="border-t-0 bg-transparent">
            <Button
              className="w-full"
              disabled={pending || !status.canManage || !status.creditPurchasesEnabled}
              aria-label={t`Subscribe to Rakazo credits`}
              onClick={() => void choose(false)}
            >
              <Trans>Subscribe</Trans>
            </Button>
          </CardFooter>
        </Card>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not open billing</Trans>
        </p>
      ) : null}
    </div>
  );
}

export function ModelCreditsSettings({
  status,
  refresh,
}: {
  status: BillingStatus;
  refresh: () => Promise<void>;
}) {
  const { t, i18n } = useLingui();
  const [amount, setAmount] = useState<CreditAmount>(
    ModelCreditAmountSchema.catch(DEFAULT_MONTHLY_CREDIT_AMOUNT).parse(status.monthlyAmountCents),
  );
  const [topupAmount, setTopupAmount] = useState<CreditAmount>(1000);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const balance = new Intl.NumberFormat(i18n.locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(status.balanceUsd ?? 0);
  async function action(work: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      await work();
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }
  const recurring =
    status.monthlyAmountCents && !["canceled", "none", "incomplete"].includes(status.state);
  const freeUntil = status.byokFreeUntil
    ? formatBillingDate(status.byokFreeUntil, i18n.locale || "en")
    : null;
  const price = status.byokPriceCents
    ? formatBillingAmount(status.byokPriceCents, "usd", i18n.locale)
    : null;
  return (
    <div data-testid="model-credits" className="space-y-5">
      <div className="rounded-xl border border-border p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm text-muted-foreground">
            <Trans>Available credits</Trans>
          </h3>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t`Refresh credits`}
            disabled={pending}
            onClick={() => void action(refresh)}
          >
            <Trans>Refresh</Trans>
          </Button>
        </div>
        <p className="mt-2 text-3xl font-medium tabular-nums">{balance}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {status.funding === "byok" && freeUntil ? (
            <Trans>Using your API key. Free plan ends {freeUntil}.</Trans>
          ) : status.funding === "byok" ? (
            <Trans>Using your API key</Trans>
          ) : (
            <Trans>Monthly credits expire at renewal. Top-ups do not expire.</Trans>
          )}
        </p>
        {status.canManage ? (
          <div className="mt-5 flex flex-wrap gap-3">
            {freeUntil && price ? (
              <Button
                disabled={pending}
                onClick={() =>
                  void action(async () => {
                    const { url } = await rpc.billing.checkout();
                    window.location.assign(url);
                  })
                }
              >
                <Trans>Subscribe for {price} / month</Trans>
              </Button>
            ) : null}
            <Button
              variant={freeUntil ? "secondary" : "default"}
              disabled={!status.creditPurchasesEnabled}
              onClick={() => setPurchaseOpen(true)}
            >
              <Trans>Add credits</Trans>
            </Button>
          </div>
        ) : null}
      </div>
      {status.canManage ? (
        <div className="rounded-xl border border-border p-5">
          <h3 className="font-medium">
            <Trans>Monthly credits</Trans>
          </h3>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <CreditAmountSelect monthly value={amount} onChange={setAmount} />
            <Button
              variant="secondary"
              disabled={
                pending ||
                !status.creditPurchasesEnabled ||
                Boolean(recurring && amount === status.monthlyAmountCents)
              }
              onClick={() =>
                void action(async () => {
                  if (recurring) {
                    await rpc.billing.setMonthlyCredits({ amountCents: amount });
                    await refresh();
                  } else {
                    const { url } = await rpc.billing.purchaseCredits({
                      amountCents: amount,
                      monthly: true,
                    });
                    window.location.assign(url);
                  }
                })
              }
            >
              {recurring ? (
                amount > (status.monthlyAmountCents ?? 0) ? (
                  <Trans>Upgrade now</Trans>
                ) : amount < (status.monthlyAmountCents ?? 0) ? (
                  <Trans>Downgrade at renewal</Trans>
                ) : (
                  <Trans>Update</Trans>
                )
              ) : (
                <Trans>Subscribe</Trans>
              )}
            </Button>
          </div>
          {status.hasCustomer ? (
            <Button
              className="mt-4"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                void action(async () => {
                  const { url } = await rpc.billing.portal();
                  window.location.assign(url);
                })
              }
            >
              <Trans>Manage billing</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      {status.canManage && status.funding === "byok" && (status.balanceUsd ?? 0) > 0 ? (
        <Button
          variant="ghost"
          disabled={pending || !status.creditPurchasesEnabled}
          onClick={() =>
            void action(async () => {
              await rpc.billing.selectFunding({ funding: "credits" });
              window.location.reload();
            })
          }
        >
          <Trans>Use Rakazo credits</Trans>
        </Button>
      ) : null}
      {status.canManage && status.funding !== "byok" && (!recurring || status.cancelAtPeriodEnd) ? (
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() =>
            void action(async () => {
              const { url } = await rpc.billing.selectFunding({ funding: "byok" });
              window.location.assign(url ?? "/onboarding");
            })
          }
        >
          <Trans>Use my subscription or API key</Trans>
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not update billing</Trans>
        </p>
      ) : null}
      <Dialog open={purchaseOpen} onOpenChange={setPurchaseOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              <Trans>Add credits</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>One-time purchase. Credits do not expire.</Trans>
            </DialogDescription>
          </DialogHeader>
          <CreditAmountSelect value={topupAmount} onChange={setTopupAmount} />
          <Button
            disabled={pending}
            onClick={() =>
              void action(async () => {
                const { url } = await rpc.billing.purchaseCredits({
                  amountCents: topupAmount,
                  monthly: false,
                });
                window.location.assign(url);
              })
            }
          >
            <Trans>Continue to checkout</Trans>
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
