import { MenuView } from "@expo/ui/community/menu";
import type { BillingStatus } from "@rakazo/contracts";
import {
  byokYearlySwitchSavings,
  DEFAULT_MONTHLY_CREDIT_AMOUNT,
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

type Amount = (typeof MODEL_CREDIT_AMOUNTS)[number];

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
  const [amount, setAmount] = useState<Amount>(DEFAULT_MONTHLY_CREDIT_AMOUNT);
  const [pending, setPending] = useState(false);
  // This screen shows the Space it opened in; every answer it gets, including a late one after a
  // Space switch, is filed under that Space.
  const [space] = useState(selectedSpaceId);
  const show = useCallback(
    (next: BillingStatus) => {
      setStatus(next);
      rememberReferral(space, next.referral);
      setAmount(
        ModelCreditAmountSchema.catch(DEFAULT_MONTHLY_CREDIT_AMOUNT).parse(next.monthlyAmountCents),
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
  const yearlySavings = byokYearlySwitchSavings(status);
  const annualCents = status.byokAnnualPriceCents;
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
          footer={endTrial ? t("Trials get fewer hours to prevent abuse.") : undefined}
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
                actions={MODEL_CREDIT_AMOUNTS.map((value) => ({
                  id: String(value),
                  title: `$${value / 100} / month`,
                  state: amount === value ? ("on" as const) : ("off" as const),
                }))}
                onPressAction={({ nativeEvent }) =>
                  setAmount(ModelCreditAmountSchema.parse(Number(nativeEvent.event)))
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
                      await rpc("billing/setMonthlyCredits", { amountCents: amount });
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
