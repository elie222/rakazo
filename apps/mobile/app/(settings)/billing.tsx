import { MenuView } from "@expo/ui/community/menu";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { BillingStatus, HeldCreditAmount } from "@rakazo/contracts";
import {
  byokTierChangeOffered,
  byokYearlySwitchSavings,
  creditAmountChoices,
  DEFAULT_MONTHLY_CREDIT_AMOUNT,
  HeldCreditAmountSchema,
  isCancelledTrial,
  MODEL_CREDIT_AMOUNTS,
  ModelCreditAmountSchema,
} from "@rakazo/contracts";
import { ownKeySubscriptionCents, subscribedTier, tierPriceCents } from "@rakazo/core";
import { writeSaved } from "@rakazo/core/query";
import { formatBillingAmount, formatBillingDate, formatMonthlyPrice } from "@rakazo/i18n/billing";
import { computerUsageDetails, tierComputerDescription } from "@rakazo/i18n/computer-usage";
import { useIsFocused, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, Share, StyleSheet } from "react-native";
import {
  SettingsGroup,
  SettingsRow,
  useStackedSettings,
} from "../../components/settings/settings-group";
import { selectedSpaceId } from "../../lib/api/api";
import { currentPlan, openBillingPage, planEndsAt } from "../../lib/billing/billing";
import { rememberReferral } from "../../lib/billing/referral";
import { useDateLocale } from "../../lib/i18n/i18n";
import { useSideInsets } from "../../lib/layout/side-insets";
import { analyticsClient } from "../../lib/native/analytics-surface";
import type { SaveSend } from "../../lib/query/query";
import { formRead, queryClient, rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import type { SettingsTarget } from "../../lib/query/settings-target";
import { openFromSettingsSheet } from "../../lib/settings/settings-sheet";

export default function BillingScreen() {
  const sideInsets = useSideInsets();
  const stacked = useStackedSettings();
  const { t } = useLingui();
  const locale = useDateLocale();
  const router = useRouter();
  const [amount, setAmount] = useState<HeldCreditAmount>(DEFAULT_MONTHLY_CREDIT_AMOUNT);
  // This screen shows the Space it opened in; its reads and saves stay there.
  const [space] = useState(() => selectedSpaceId() ?? undefined);
  const target: SettingsTarget | undefined = space ? { scope: "space", spaceId: space } : undefined;
  // What is offered here depends on the status as it is now, so each visit reads it afresh.
  const statusRead = formRead(rpcQuery("billing/status", undefined, space));
  const statusQuery = useScreenQuery(statusRead);
  const status = (statusQuery.isFetchedAfterMount && statusQuery.data) || null;
  const [showComputerUsage, setShowComputerUsage] = useState(false);
  const usageRead = rpcQuery("billing/computerUsage", undefined, space);
  const computerUsage = useScreenQuery(usageRead, {
    enabled: showComputerUsage && status?.canManage === true && status.computerHoursLeft != null,
  });
  useEffect(() => {
    if (!status) return;
    rememberReferral(space ?? null, status.referral);
    setAmount(
      HeldCreditAmountSchema.catch(DEFAULT_MONTHLY_CREDIT_AMOUNT).parse(status.monthlyAmountCents),
    );
  }, [status, space]);
  const { error: readError, errorUpdatedAt } = statusQuery;
  // A read that fails after leaving the screen must not alert over the page now shown.
  const focused = useRef(false);
  focused.current = useIsFocused();
  useEffect(() => {
    if (readError && focused.current) Alert.alert(t`Could not load billing`);
  }, [readError, errorUpdatedAt, t]);
  type BillingChange = (send: SaveSend) => Promise<BillingStatus | undefined>;
  const change = useSave({
    target,
    stale: [usageRead.queryKey],
    save: async ({ work }: { work: BillingChange; failure?: string }, send) => {
      const next = await work(send);
      if (next) await writeSaved(queryClient, statusRead.queryKey, () => next);
    },
    onFailed: (error, { failure }) =>
      Alert.alert(
        failure ??
          ((error as { status?: number }).status === 402
            ? t`Your card was not charged`
            : t`Could not update billing`),
      ),
  });
  const pending = change.pending;
  const action = (work: BillingChange, failure?: string) => change.run({ work, failure });
  if (!status) return null;
  const usageDetails =
    status.canManage && showComputerUsage ? computerUsageDetails(computerUsage, locale) : null;
  const usd = (cents: number) => formatBillingAmount(cents, "usd", locale);
  const monthly = (cents: number) => formatMonthlyPrice(cents, locale);
  const formatDate = (iso: string) => formatBillingDate(iso, locale);

  const plan = currentPlan(status);
  const endsAt = planEndsAt(status);
  const ownKeyCents = ownKeySubscriptionCents(status);
  const recurring = Boolean(
    status.monthlyAmountCents && !["none", "canceled", "incomplete"].includes(status.state),
  );
  // Owners can always top up, as on web; a top-up is how an own-key plan starts on credits.
  const credits = status.funding === "credits" || (status.balanceUsd ?? 0) > 0 || status.canManage;
  const referral = status.referral;
  const endTrial = status.canManage && status.state === "trialing" && !status.cancelAtPeriodEnd;
  const cancelledTrial = isCancelledTrial(status);
  const yearlySavings = byokYearlySwitchSavings(status);
  const annualCents = status.byokAnnualPriceCents;
  const tiers = status.byokTiers ?? [];
  type TierOffer = (typeof tiers)[number];
  const currentTier = ownKeyCents ? subscribedTier(status) : undefined;
  const tierChange = byokTierChangeOffered(status);
  const interval = status.byokInterval ?? "month";
  const tierCents = (offer: TierOffer) => tierPriceCents(offer, interval);
  /** "$49 / month", at the plan's interval. */
  const tierPrice = (cents: number) => {
    const price = usd(cents);
    return interval === "year" ? t`${price} / year` : t`${price} / month`;
  };
  const changeTier = (offer: TierOffer, cents: number) =>
    Alert.alert(
      t`Switch to ${ph({ name: offer.name })}?`,
      // What the tier gives, then how the change bills.
      `${tierComputerDescription(offer)}\n\n${
        status.state === "trialing"
          ? t`Your plan becomes ${ph({ price: tierPrice(cents) })} when your trial ends.`
          : cents > (ownKeyCents ?? 0)
            ? t`Your card is charged the prorated difference today.`
            : t`The unused difference is credited to your next invoice.`
      }`,
      [
        { text: t`Cancel`, style: "cancel" },
        {
          text: t`Switch`,
          onPress: () => action((send) => send("billing/changeTier", { tier: offer.tier })),
        },
      ],
    );
  const tierRow = currentTier ? (
    <SettingsRow
      title={currentTier.name}
      detail={tierComputerDescription(currentTier)}
      chevron={tierChange ? "down" : undefined}
      disabled={pending}
    />
  ) : null;
  return (
    <ScrollView
      style={sideInsets}
      contentContainerStyle={[styles.content, stacked && styles.compactContent]}
      contentInsetAdjustmentBehavior="automatic"
    >
      <SettingsGroup>
        <SettingsRow
          title={t`Plan`}
          detail={
            ownKeyCents
              ? status.byokInterval === "year"
                ? t`${ph({ price: usd(ownKeyCents) })} / year`
                : t`${ph({ price: usd(ownKeyCents) })} / month`
              : undefined
          }
          value={
            status.state === "trialing" || status.byokFreeUntil
              ? t`Free trial`
              : plan === "byok"
                ? t`Your subscription or API key`
                : plan === "credits"
                  ? t`Rakazo credits`
                  : t`None`
          }
        />
        {currentTier && tierChange ? (
          <MenuView
            actions={tiers.flatMap((offer) => {
              const cents = tierCents(offer);
              return cents === null
                ? []
                : [
                    {
                      id: offer.tier,
                      title: `${offer.name} · ${tierPrice(cents)}`,
                      state: offer.tier === currentTier.tier ? ("on" as const) : ("off" as const),
                    },
                  ];
            })}
            onPressAction={({ nativeEvent }) => {
              const offer = tiers.find((candidate) => candidate.tier === nativeEvent.event);
              const cents = offer && tierCents(offer);
              if (offer && cents != null && offer.tier !== currentTier.tier)
                changeTier(offer, cents);
            }}
          >
            {tierRow}
          </MenuView>
        ) : (
          tierRow
        )}
        {endsAt ? (
          <SettingsRow
            title={status.cancelAtPeriodEnd ? t`Ends` : t`Free until`}
            value={formatDate(endsAt)}
          />
        ) : status.access && status.currentPeriodEndsAt ? (
          <SettingsRow title={t`Renews`} value={formatDate(status.currentPeriodEndsAt)} />
        ) : null}
        {yearlySavings !== null && annualCents ? (
          <SettingsRow
            title={t`Switch to yearly`}
            value={`−${yearlySavings}%`}
            disabled={pending}
            onPress={() =>
              Alert.alert(
                t`Switch to yearly?`,
                status.state === "trialing"
                  ? t`Your plan becomes ${ph({ price: usd(annualCents) })} / year when your trial ends.`
                  : t`Your card is charged ${ph({ price: usd(annualCents) })} today, less the unused part of this month.`,
                [
                  { text: t`Cancel`, style: "cancel" },
                  {
                    text: t`Switch`,
                    onPress: () => action((send) => send("billing/switchToYearly", undefined)),
                  },
                ],
              )
            }
          />
        ) : null}
        {status.canManage ? (
          <SettingsRow
            title={plan && !status.byokFreeUntil ? t`Change plan` : t`Choose a plan`}
            prominent
            onPress={() => openFromSettingsSheet(router, "/paywall?dismissible=1")}
          />
        ) : null}
      </SettingsGroup>
      {status.computerHoursLeft != null ? (
        <SettingsGroup
          footer={
            endTrial
              ? t`Trials get fewer hours to prevent abuse.`
              : cancelledTrial
                ? t`Cancelled trials have no computer hours.`
                : undefined
          }
        >
          <SettingsRow title={t`Computer hours left`} value={String(status.computerHoursLeft)} />
          {status.computerHoursResetAt ? (
            <SettingsRow title={t`Resets`} value={formatDate(status.computerHoursResetAt)} />
          ) : null}
          {status.canManage ? (
            <SettingsRow
              title={
                status.standardComputerHours ? t`Standard hours by computer` : t`Hours by computer`
              }
              chevron={showComputerUsage ? "down" : "right"}
              accessibilityState={{ expanded: showComputerUsage }}
              onPress={() => setShowComputerUsage((open) => !open)}
            />
          ) : null}
          {usageDetails?.rows.map((row) => (
            <SettingsRow key={row.id} title={row.label} value={row.hours} />
          ))}
          {usageDetails?.message ? <SettingsRow title={usageDetails.message} /> : null}
          {endTrial ? (
            <SettingsRow
              title={t`Start plan now`}
              disabled={pending}
              onPress={() =>
                Alert.alert(
                  t`Start your plan now?`,
                  ownKeyCents
                    ? t`Your trial ends and your card is charged ${ph({ price: usd(ownKeyCents) })} today.`
                    : t`Your trial ends and your card is charged today.`,
                  [
                    { text: t`Cancel`, style: "cancel" },
                    {
                      text: t`Start plan`,
                      onPress: () => action((send) => send("billing/endTrial", undefined)),
                    },
                  ],
                )
              }
            />
          ) : null}
          {cancelledTrial && status.canManage && status.hasCustomer ? (
            <SettingsRow
              title={t`Renew plan`}
              disabled={pending}
              onPress={() =>
                action(async (send) => {
                  const result = await send("billing/portal", { client: "mobile" });
                  return openBillingPage(result.url, send);
                })
              }
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      {referral ? (
        <SettingsGroup footer={t`Get a free month for each friend who starts a trial.`}>
          <SettingsRow
            title={t`Invite friends`}
            detail={
              referral.rewards === 0
                ? undefined
                : referral.rewards === 1
                  ? t`1 free month earned`
                  : t`${ph({ count: referral.rewards })} free months earned`
            }
            chevron="right"
            onPress={() => void Share.share({ message: referral.url }).catch(() => undefined)}
          />
        </SettingsGroup>
      ) : null}
      {credits ? (
        <SettingsGroup
          label={t`Credits`}
          footer={
            recurring ? t`Monthly credits expire at renewal. Top-ups do not expire.` : undefined
          }
        >
          <SettingsRow
            title={t`Available credits`}
            value={new Intl.NumberFormat(locale, {
              style: "currency",
              currency: "USD",
            }).format(status.balanceUsd ?? 0)}
          />
          {status.canManage && recurring ? (
            <>
              <MenuView
                actions={creditAmountChoices(amount).map((value) => ({
                  id: String(value),
                  title: monthly(value),
                  state: amount === value ? ("on" as const) : ("off" as const),
                }))}
                onPressAction={({ nativeEvent }) =>
                  setAmount(HeldCreditAmountSchema.parse(Number(nativeEvent.event)))
                }
              >
                <SettingsRow
                  title={t`Monthly credits`}
                  value={monthly(amount)}
                  chevron="down"
                  disabled={pending}
                />
              </MenuView>
              {amount !== status.monthlyAmountCents ? (
                <SettingsRow
                  title={
                    amount > (status.monthlyAmountCents ?? 0)
                      ? t`Upgrade now`
                      : t`Downgrade at renewal`
                  }
                  disabled={pending}
                  onPress={() =>
                    action(async (send) => {
                      await send("billing/setMonthlyCredits", {
                        amountCents: ModelCreditAmountSchema.parse(amount),
                      });
                      return send("billing/refresh", undefined);
                    })
                  }
                />
              ) : null}
            </>
          ) : null}
          {status.canManage ? (
            <MenuView
              actions={MODEL_CREDIT_AMOUNTS.map((value) => ({
                id: String(value),
                title: usd(value),
              }))}
              onPressAction={({ nativeEvent }) =>
                action(async (send) => {
                  const result = await send("billing/purchaseCredits", {
                    amountCents: ModelCreditAmountSchema.parse(Number(nativeEvent.event)),
                    monthly: false,
                    client: "mobile",
                  });
                  return openBillingPage(result.url, send);
                })
              }
            >
              <SettingsRow
                title={t`Add credits`}
                chevron="right"
                disabled={pending || !status.creditPurchasesEnabled}
              />
            </MenuView>
          ) : null}
          {status.canManage && status.funding === "byok" && (status.balanceUsd ?? 0) > 0 ? (
            <SettingsRow
              title={t`Use Rakazo credits`}
              disabled={pending || !status.creditPurchasesEnabled}
              onPress={() =>
                action(async (send) => {
                  await send("billing/selectFunding", {
                    funding: "credits",
                    ...analyticsClient(),
                  });
                  router.replace("/models");
                  return undefined;
                })
              }
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      {status.canManage && status.hasCustomer ? (
        <SettingsGroup>
          <SettingsRow
            title={t`Manage billing`}
            chevron="right"
            disabled={pending}
            onPress={() =>
              action(async (send) => {
                const result = await send("billing/portal", { client: "mobile" });
                return openBillingPage(result.url, send);
              })
            }
          />
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 28 },
  compactContent: { paddingHorizontal: 8 },
});
