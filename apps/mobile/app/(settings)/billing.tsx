import { MenuView } from "@expo/ui/community/menu";
import type { BillingStatus } from "@rakazo/contracts";
import {
  DEFAULT_MONTHLY_CREDIT_AMOUNT,
  MODEL_CREDIT_AMOUNTS,
  ModelCreditAmountSchema,
} from "@rakazo/contracts";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, AppState, Linking, ScrollView } from "react-native";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

type Amount = (typeof MODEL_CREDIT_AMOUNTS)[number];
export default function BillingScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [amount, setAmount] = useState<Amount>(DEFAULT_MONTHLY_CREDIT_AMOUNT);
  const [pending, setPending] = useState(false);
  const refresh = useCallback(async () => {
    const next = await rpc<BillingStatus>("billing/status");
    setStatus(next);
    setAmount(
      ModelCreditAmountSchema.catch(DEFAULT_MONTHLY_CREDIT_AMOUNT).parse(next.monthlyAmountCents),
    );
  }, []);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const load = () => {
        void rpc<BillingStatus>("billing/status")
          .then((next) => {
            if (active) {
              setStatus(next);
              setAmount(
                ModelCreditAmountSchema.catch(DEFAULT_MONTHLY_CREDIT_AMOUNT).parse(
                  next.monthlyAmountCents,
                ),
              );
            }
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
    }, [t]),
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
  const recurring = Boolean(
    status?.monthlyAmountCents && !["none", "canceled", "incomplete"].includes(status.state),
  );
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      <SettingsGroup label={t("Credits")}>
        <SettingsRow
          title={t("Available credits")}
          value={`$${(status?.balanceUsd ?? 0).toFixed(2)}`}
        />
        <SettingsRow title={t("Refresh")} disabled={pending} onPress={() => void action(refresh)} />
      </SettingsGroup>
      {status?.canManage ? (
        <>
          <SettingsGroup
            label={t("Monthly credits")}
            footer={t("Monthly credits expire at renewal. Top-ups do not expire.")}
          >
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
            <SettingsRow
              title={
                recurring
                  ? amount > (status.monthlyAmountCents ?? 0)
                    ? t("Upgrade now")
                    : amount < (status.monthlyAmountCents ?? 0)
                      ? t("Downgrade at renewal")
                      : t("Update")
                  : t("Continue with credits")
              }
              disabled={pending || !status.creditPurchasesEnabled}
              onPress={() =>
                void action(async () => {
                  if (recurring) {
                    await rpc("billing/setMonthlyCredits", { amountCents: amount });
                    await refresh();
                  } else {
                    const result = await rpc<{ url: string }>("billing/purchaseCredits", {
                      amountCents: amount,
                      monthly: true,
                    });
                    await Linking.openURL(result.url);
                  }
                })
              }
            />
          </SettingsGroup>
          <SettingsGroup>
            <MenuView
              actions={MODEL_CREDIT_AMOUNTS.map((value) => ({
                id: String(value),
                title: `$${value / 100}`,
              }))}
              onPressAction={({ nativeEvent }) =>
                void action(async () => {
                  const amountCents = ModelCreditAmountSchema.parse(Number(nativeEvent.event));
                  const result = await rpc<{ url: string }>("billing/purchaseCredits", {
                    amountCents,
                    monthly: false,
                  });
                  await Linking.openURL(result.url);
                })
              }
            >
              <SettingsRow
                title={t("Add credits")}
                chevron="right"
                disabled={pending || !status.creditPurchasesEnabled}
              />
            </MenuView>
            {status.hasCustomer ? (
              <SettingsRow
                title={t("Manage billing")}
                disabled={pending}
                onPress={() =>
                  void action(async () => {
                    const result = await rpc<{ url: string }>("billing/portal");
                    await Linking.openURL(result.url);
                  })
                }
              />
            ) : null}
          </SettingsGroup>
          {status.funding === "byok" && (status.balanceUsd ?? 0) > 0 ? (
            <SettingsGroup>
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
            </SettingsGroup>
          ) : null}
          {!recurring || status.cancelAtPeriodEnd ? (
            <SettingsGroup
              label={t("Your subscription or API key")}
              footer={t("Free. ChatGPT, Claude, or any model provider.")}
            >
              <SettingsRow
                title={t("Use my subscription or API key")}
                disabled={pending}
                onPress={() =>
                  void action(async () => {
                    await rpc("billing/selectFunding", { funding: "byok" });
                    router.replace("/models");
                  })
                }
              />
            </SettingsGroup>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
