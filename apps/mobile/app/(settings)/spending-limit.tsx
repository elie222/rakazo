import { useLingui } from "@lingui/react/macro";
import type { SpendingCurrency, SpendingLimit, SpendingPeriod } from "@rakazo/contracts";
import { SPENDING_CURRENCIES } from "@rakazo/contracts";
import { formatMinorAmount, parseLimitInput } from "@rakazo/core";
import { writeSaved } from "@rakazo/core/query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform, ScrollView, StyleSheet, View } from "react-native";
import { LoadFailure } from "../../components/load-failure";
import { MenuPickerMenu } from "../../components/menu-picker";
import { TextFieldDialog } from "../../components/name-dialog";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow, useStackedSettings } from "../../components/settings-group";
import { formatActivityRelativeTime } from "../../lib/activity";
import { dateLocaleForUi, useUiLocale } from "../../lib/i18n";
import { native } from "../../lib/native";
import { accountRpcQuery, formRead, queryClient, useSave } from "../../lib/query";
import { useScreenQuery } from "../../lib/screen-query";
import { ACCOUNT_SETTINGS } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { spendingSpentSummary } from "../../lib/spending-limit";
import { errorText } from "../../lib/user-error";

/** The most the user's bots may spend, across every bot and Space. */
export default function SpendingLimitSettings() {
  const { t } = useLingui();
  const locale = useUiLocale();
  const sideInsets = useSideInsets();
  const stacked = useStackedSettings();
  // A change is built from the limit on screen, so each visit reads it afresh.
  const statusRead = formRead(accountRpcQuery("spendingLimit/get"));
  const paymentsRead = accountRpcQuery("spendingLimit/payments");
  const statusQuery = useScreenQuery(statusRead);
  // The list is extra: without it the limit can still be set.
  const paymentsQuery = useScreenQuery(paymentsRead);
  // A copy an earlier visit left is not what a change may be built from.
  const status = (statusQuery.isFetchedAfterMount && statusQuery.data) || null;
  const payments = paymentsQuery.data ?? [];
  // A failed read stays on screen while its retry is in flight, until that one answers.
  const [loadFailure, setLoadFailure] = useState<Error | null>(null);
  useEffect(() => {
    if (statusQuery.error) setLoadFailure(statusQuery.error);
    else if (statusQuery.data) setLoadFailure(null);
  }, [statusQuery.error, statusQuery.data]);
  const reads = useRef([statusRead, paymentsRead]);
  reads.current = [statusRead, paymentsRead];
  // A read still in flight when the screen is covered is dropped, so the return reads afresh.
  useFocusEffect(
    useCallback(
      () => () => {
        for (const { queryKey } of reads.current)
          void queryClient.cancelQueries({ queryKey, exact: true });
      },
      [],
    ),
  );
  // Starts each read over, so the answer comes from the latest tap.
  const reload = () => {
    for (const { queryKey } of reads.current)
      void queryClient.resetQueries({ queryKey, exact: true });
  };
  // The Android field's text while it is open; iOS uses the system prompt.
  const [draft, setDraft] = useState<string | null>(null);

  const limit = status?.limit ?? null;

  const change = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (next: SpendingLimit | null, send) => {
      const saved = await send("spendingLimit/set", { limit: next });
      // A read that started before the change never puts back what it replaced.
      await writeSaved(queryClient, statusRead.queryKey, () => saved);
    },
    onSaved: () => setDraft(null),
    onFailed: (err) => Alert.alert(errorText(err, t`Could not save that preference`)),
  });
  const pending = change.pending;
  const save = change.run;

  function saveAmount(text: string) {
    const amount = parseLimitInput(text);
    if (amount === null) {
      Alert.alert(t`Enter an amount`);
      return;
    }
    save({ amount, currency: limit?.currency ?? "usd", period: limit?.period ?? "month" });
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
        {loadFailure && !status ? (
          <LoadFailure
            message={errorText(loadFailure, t`Something went wrong. Try again.`)}
            onRetry={reload}
          />
        ) : null}
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
              ? chooser(t`Currency`, limit.currency, currencies, (key) =>
                  save({ ...limit, currency: key as SpendingCurrency }),
                )
              : null}
            {limit
              ? chooser(t`Resets`, limit.period, periods, (key) =>
                  save({ ...limit, period: key as SpendingPeriod }),
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
              onPress={() => save(null)}
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
