import { MenuView } from "@expo/ui/community/menu";
import type { BillingStatus, HeldCreditAmount } from "@rakazo/contracts";
import {
  ByokTierSchema,
  byokTierChangeOffered,
  byokYearlySwitchSavings,
  COMPUTER_SIZE_SPECS,
  creditAmountChoices,
  DEFAULT_MONTHLY_CREDIT_AMOUNT,
  HeldCreditAmountSchema,
  isCancelledTrial,
  MODEL_CREDIT_AMOUNTS,
  ModelCreditAmountSchema,
} from "@rakazo/contracts";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, AppState, ScrollView, Share, StyleSheet } from "react-native";
import { SettingsGroup, SettingsRow, useStackedSettings } from "../../components/settings-group";
import { rpc, selectedSpaceId } from "../../lib/api";
import {
  currentPlan,
  openBillingPage,
  ownKeySubscriptionCents,
  planEndsAt,
} from "../../lib/billing";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import { rememberReferral } from "../../lib/referral";
import { openFromSettingsSheet } from "../../lib/settings-sheet";
import { useSideInsets } from "../../lib/side-insets";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(dateLocaleForUi(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function BillingScreen() {
  const sideInsets = useSideInsets();
  const stacked = useStackedSettings();
  const { t } = useI18n();
  const router = useRouter();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [amount, setAmount] = useState<HeldCreditAmount>(DEFAULT_MONTHLY_CREDIT_AMOUNT);
  const [pending, setPending] = useState(false);
  // This screen shows the Space it opened in; every answer it gets, including a late one after a
  // Space switch, is filed under that Space.
  const [space] = useState(selectedSpaceId);
  const show = useCallback(
    (next: BillingStatus) => {
      setStatus(next);
      rememberReferral(space, next.referral);
      setAmount(
        HeldCreditAmountSchema.catch(DEFAULT_MONTHLY_CREDIT_AMOUNT).parse(next.monthlyAmountCents),
      );
    },
    [space],
  );
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const load = () => {
        void rpc("billing/status")
          .then((next) => {
            if (active) show(next);
          })
          .catch(() => {
            if (active) Alert.alert(t("Could not load billing"));
          });
      };
      load();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") load();
      });
      return () => {
        active = false;
        subscription.remove();
      };
    }, [show, t]),
  );
  async function action(work: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    try {
      await work();
    } catch {
      Alert.alert(t("Could not update billing"));
    } finally {
      setPending(false);
    }
  }
  if (!status) return null;

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
  const currentTier = ownKeyCents
    ? tiers.find((offer) => offer.tier === ByokTierSchema.catch("standard").parse(status.byokTier))
    : undefined;
  const tierChange = byokTierChangeOffered(status);
  const interval = status.byokInterval ?? "month";
  const tierCents = (offer: TierOffer) =>
    interval === "year" ? offer.annualPriceCents : offer.monthlyPriceCents;
  /** "$49 / month", at the plan's interval. */
  const tierPrice = (cents: number) => {
    const price = `$${cents / 100}`;
    return interval === "year" ? t("{price} / year", { price }) : t("{price} / month", { price });
  };
  const tierComputer = (offer: TierOffer) =>
    t("{vcpus} vCPU, {memoryGb} GB, {hours} computer hours a month", {
      vcpus: COMPUTER_SIZE_SPECS[offer.computerSize].vcpus,
      memoryGb: COMPUTER_SIZE_SPECS[offer.computerSize].memoryGb,
      hours: offer.computerHours,
    });
  const changeTier = (offer: TierOffer, cents: number) =>
    Alert.alert(
      t("Switch to {name}?", { name: offer.name }),
      // What the tier gives, then how the change bills.
      `${tierComputer(offer)}\n\n${
        status.state === "trialing"
          ? t("Your plan becomes {price} when your trial ends.", { price: tierPrice(cents) })
          : cents > (ownKeyCents ?? 0)
            ? t("Your card is charged the prorated difference today.")
            : t("The unused difference is credited to your next invoice.")
      }`,
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Switch"),
          onPress: () =>
            void action(async () => {
              show(await rpc("billing/changeTier", { tier: offer.tier }));
            }),
        },
      ],
    );
  const tierRow = currentTier ? (
    <SettingsRow
      title={currentTier.name}
      detail={tierComputer(currentTier)}
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
          title={t("Plan")}
          detail={
            ownKeyCents
              ? status.byokInterval === "year"
                ? t("{price} / year", { price: `$${ownKeyCents / 100}` })
                : t("{price} / month", { price: `$${ownKeyCents / 100}` })
              : undefined
          }
          value={
            status.state === "trialing" || status.byokFreeUntil
              ? t("Free trial")
              : plan === "byok"
                ? t("Your subscription or API key")
                : plan === "credits"
                  ? t("Rakazo credits")
                  : t("None")
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
            title={status.cancelAtPeriodEnd ? t("Ends") : t("Free until")}
            value={formatDate(endsAt)}
          />
        ) : status.access && status.currentPeriodEndsAt ? (
          <SettingsRow title={t("Renews")} value={formatDate(status.currentPeriodEndsAt)} />
        ) : null}
        {yearlySavings !== null && annualCents ? (
          <SettingsRow
            title={t("Switch to yearly")}
            value={`−${yearlySavings}%`}
            disabled={pending}
            onPress={() =>
              Alert.alert(
                t("Switch to yearly?"),
                status.state === "trialing"
                  ? t("Your plan becomes {price} / year when your trial ends.", {
                      price: `$${annualCents / 100}`,
                    })
                  : t("Your card is charged {price} today, less the unused part of this month.", {
                      price: `$${annualCents / 100}`,
                    }),
                [
                  { text: t("Cancel"), style: "cancel" },
                  {
                    text: t("Switch"),
                    onPress: () =>
                      void action(async () => {
                        show(await rpc("billing/switchToYearly"));
                      }),
                  },
                ],
              )
            }
          />
        ) : null}
        {status.canManage ? (
          <SettingsRow
            title={plan && !status.byokFreeUntil ? t("Change plan") : t("Choose a plan")}
            prominent
            onPress={() => openFromSettingsSheet(router, "/paywall?dismissible=1")}
          />
        ) : null}
      </SettingsGroup>
      {status.computerHoursLeft != null ? (
        <SettingsGroup
          footer={
            endTrial
              ? t("Trials get fewer hours to prevent abuse.")
              : cancelledTrial
                ? t("Cancelled trials have no computer hours.")
                : undefined
          }
        >
          <SettingsRow title={t("Computer hours left")} value={String(status.computerHoursLeft)} />
          {endTrial ? (
            <SettingsRow
              title={t("Start plan now")}
              disabled={pending}
              onPress={() =>
                Alert.alert(
                  t("Start your plan now?"),
                  ownKeyCents
                    ? t("Your trial ends and your card is charged {price} today.", {
                        price: `$${ownKeyCents / 100}`,
                      })
                    : t("Your trial ends and your card is charged today."),
                  [
                    { text: t("Cancel"), style: "cancel" },
                    {
                      text: t("Start plan"),
                      onPress: () =>
                        void action(async () => {
                          show(await rpc("billing/endTrial"));
                        }),
                    },
                  ],
                )
              }
            />
          ) : null}
          {cancelledTrial && status.canManage && status.hasCustomer ? (
            <SettingsRow
              title={t("Renew plan")}
              disabled={pending}
              onPress={() =>
                void action(async () => {
                  const result = await rpc("billing/portal", { client: "mobile" });
                  show(await openBillingPage(result.url));
                })
              }
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      {referral ? (
        <SettingsGroup footer={t("Get a free month for each friend who starts a trial.")}>
          <SettingsRow
            title={t("Invite friends")}
            detail={
              referral.rewards === 0
                ? undefined
                : referral.rewards === 1
                  ? t("1 free month earned")
                  : t("{count} free months earned", { count: referral.rewards })
            }
            chevron="right"
            onPress={() => void Share.share({ message: referral.url }).catch(() => undefined)}
          />
        </SettingsGroup>
      ) : null}
      {credits ? (
        <SettingsGroup
          label={t("Credits")}
          footer={
            recurring ? t("Monthly credits expire at renewal. Top-ups do not expire.") : undefined
          }
        >
          <SettingsRow
            title={t("Available credits")}
            value={`$${(status.balanceUsd ?? 0).toFixed(2)}`}
          />
          {status.canManage && recurring ? (
            <>
              <MenuView
                actions={creditAmountChoices(amount).map((value) => ({
                  id: String(value),
                  title: `$${value / 100} / month`,
                  state: amount === value ? ("on" as const) : ("off" as const),
                }))}
                onPressAction={({ nativeEvent }) =>
                  setAmount(HeldCreditAmountSchema.parse(Number(nativeEvent.event)))
                }
              >
                <SettingsRow
                  title={t("Monthly credits")}
                  value={`$${amount / 100} / month`}
                  chevron="down"
                  disabled={pending}
                />
              </MenuView>
              {amount !== status.monthlyAmountCents ? (
                <SettingsRow
                  title={
                    amount > (status.monthlyAmountCents ?? 0)
                      ? t("Upgrade now")
                      : t("Downgrade at renewal")
                  }
                  disabled={pending}
                  onPress={() =>
                    void action(async () => {
                      await rpc("billing/setMonthlyCredits", {
                        amountCents: ModelCreditAmountSchema.parse(amount),
                      });
                      show(await rpc("billing/refresh"));
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
                title: `$${value / 100}`,
              }))}
              onPressAction={({ nativeEvent }) =>
                void action(async () => {
                  const result = await rpc("billing/purchaseCredits", {
                    amountCents: ModelCreditAmountSchema.parse(Number(nativeEvent.event)),
                    monthly: false,
                    client: "mobile",
                  });
                  show(await openBillingPage(result.url));
                })
              }
            >
              <SettingsRow
                title={t("Add credits")}
                chevron="right"
                disabled={pending || !status.creditPurchasesEnabled}
              />
            </MenuView>
          ) : null}
          {status.canManage && status.funding === "byok" && (status.balanceUsd ?? 0) > 0 ? (
            <SettingsRow
              title={t("Use Rakazo credits")}
              disabled={pending || !status.creditPurchasesEnabled}
              onPress={() =>
                void action(async () => {
                  await rpc("billing/selectFunding", { funding: "credits" });
                  router.replace("/models");
                })
              }
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      {status.canManage && status.hasCustomer ? (
        <SettingsGroup>
          <SettingsRow
            title={t("Manage billing")}
            chevron="right"
            disabled={pending}
            onPress={() =>
              void action(async () => {
                const result = await rpc("billing/portal", { client: "mobile" });
                show(await openBillingPage(result.url));
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
