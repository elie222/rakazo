import { useLingui } from "@lingui/react/macro";
import type {
  SpendingCurrency,
  SpendingLimit,
  SpendingPayment,
  SpendingPeriod,
  SpendingStatus,
} from "@rakazo/contracts";
import { SPENDING_CURRENCIES } from "@rakazo/contracts";
import { formatMinorAmount, parseLimitInput } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, Platform, ScrollView, StyleSheet, View } from "react-native";
import { LoadFailure } from "../../components/load-failure";
import { MenuPickerMenu } from "../../components/menu-picker";
import { TextFieldDialog } from "../../components/name-dialog";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow, useStackedSettings } from "../../components/settings-group";
import { formatActivityRelativeTime } from "../../lib/activity";
import { rpc } from "../../lib/api";
import { dateLocaleForUi, useUiLocale } from "../../lib/i18n";
import { native } from "../../lib/native";
import { useSideInsets } from "../../lib/side-insets";
import { spendingSpentSummary } from "../../lib/spending-limit";
import { errorText } from "../../lib/user-error";

/** The most the user's bots may spend, across every bot and Space. */
export default function SpendingLimitSettings() {
  const { t } = useLingui();
  const locale = useUiLocale();
  const sideInsets = useSideInsets();
  const stacked = useStackedSettings();
  const [status, setStatus] = useState<SpendingStatus | null>(null);
  const [payments, setPayments] = useState<SpendingPayment[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The Android field's text while it is open; iOS uses the system prompt.
  const [draft, setDraft] = useState<string | null>(null);
  // Bumped by saves, so a read started before one cannot overwrite its result.
  const generation = useRef(0);
  // Bumped by each reload and blur, so stale reads cannot replace current results.
  const listReads = useRef(0);

  const reload = useCallback(() => {
    const started = generation.current;
    const read = ++listReads.current;
    void rpc("spendingLimit/get")
      .then((next) => {
        if (started !== generation.current || read !== listReads.current) return;
        setStatus(next);
        setLoadError(null);
      })
      .catch((err) => {
        if (started !== generation.current || read !== listReads.current) return;
        setLoadError(errorText(err, t`Something went wrong. Try again.`));
      });
    // The list is extra: without it the limit can still be set.
    void rpc("spendingLimit/payments")
      .then((next) => {
        if (read === listReads.current) setPayments(next);
      })
      .catch(() => undefined);
  }, [t]);
  useFocusEffect(
    useCallback(() => {
      reload();
      return () => {
        listReads.current += 1;
      };
    }, [reload]),
  );

  const limit = status?.limit ?? null;

  async function save(next: SpendingLimit | null) {
    if (pending) return;
    setPending(true);
    generation.current += 1;
    try {
      setStatus(await rpc("spendingLimit/set", { limit: next }));
      setDraft(null);
    } catch (err) {
      Alert.alert(errorText(err, t`Could not save that preference`));
    } finally {
      setPending(false);
    }
  }

  function saveAmount(text: string) {
    const amount = parseLimitInput(text);
    if (amount === null) {
      Alert.alert(t`Enter an amount`);
      return;
    }
    void save({ amount, currency: limit?.currency ?? "usd", period: limit?.period ?? "month" });
  }

  function askAmount() {
    const current = limit ? String(limit.amount / 100) : "";
    if (Platform.OS !== "ios") {
      setDraft(current);
      return;
    }
    Alert.prompt(
      t`Spending limit`,
      undefined,
      [
        { text: t`Cancel`, style: "cancel" },
        { text: t`Save`, onPress: (entered?: string) => saveAmount(entered ?? "") },
      ],
      "plain-text",
      current,
      "decimal-pad",
    );
  }

  const periods: Array<{ key: SpendingPeriod; label: string }> = [
    { key: "day", label: t`Daily` },
    { key: "week", label: t`Weekly` },
    { key: "month", label: t`Monthly` },
    { key: "none", label: t`No reset` },
  ];
  const currencies = SPENDING_CURRENCIES.map((key) => ({ key, label: key.toUpperCase() }));
  const chooser = (
    label: string,
    value: string,
    choices: Array<{ key: string; label: string }>,
    onChange: (key: string) => void,
  ) => (
    <MenuPickerMenu
      choices={choices}
      disabled={pending}
      label={label}
      onChange={onChange}
      value={value}
    >
      <View>
        <SettingsRow
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          dimmed={pending}
          title={label}
          trailing={
            <NativeSymbol
              android="chevron-expand"
              color={native.tertiaryLabel}
              ios="chevron.up.chevron.down"
              size={13}
            />
          }
          value={choices.find((choice) => choice.key === value)?.label}
        />
      </View>
    </MenuPickerMenu>
  );

  return (
    <>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={[styles.content, stacked && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
      >
        {loadError && !status ? <LoadFailure message={loadError} onRetry={reload} /> : null}
        {status ? (
          <SettingsGroup>
            <SettingsRow
              accessibilityRole="button"
              detail={limit ? spendingSpentSummary(locale, status.spent, limit) : undefined}
              dimmed={pending}
              onPress={askAmount}
              title={t`Amount`}
              value={
                limit
                  ? formatMinorAmount(limit.amount, limit.currency, dateLocaleForUi(locale))
                  : t`None`
              }
            />
            {limit
              ? chooser(
                  t`Currency`,
                  limit.currency,
                  currencies,
                  (key) => void save({ ...limit, currency: key as SpendingCurrency }),
                )
              : null}
            {limit
              ? chooser(
                  t`Resets`,
                  limit.period,
                  periods,
                  (key) => void save({ ...limit, period: key as SpendingPeriod }),
                )
              : null}
          </SettingsGroup>
        ) : null}
        {limit ? (
          <SettingsGroup>
            <SettingsRow
              accessibilityRole="button"
              destructive
              disabled={pending}
              onPress={() => void save(null)}
              title={t`Remove`}
            />
          </SettingsGroup>
        ) : null}
        {status && payments.length ? (
          <SettingsGroup label={t`Recent payments`}>
            {payments.map((payment) => (
              <SettingsRow
                key={payment.id}
                detail={[payment.botName, formatActivityRelativeTime(payment.createdAt)]
                  .filter(Boolean)
                  .join(" · ")}
                title={payment.site}
                value={formatMinorAmount(payment.amount, payment.currency, dateLocaleForUi(locale))}
              />
            ))}
          </SettingsGroup>
        ) : null}
      </ScrollView>
      {draft !== null ? (
        <TextFieldDialog
          title={t`Spending limit`}
          label={t`Amount`}
          submitLabel={t`Save`}
          value={draft}
          error={null}
          saving={pending}
          input={{ keyboardType: "decimal-pad", autoFocus: true }}
          onChange={setDraft}
          onSubmit={saveAmount}
          onClose={() => setDraft(null)}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 24 },
  compactContent: { paddingHorizontal: 8 },
});
