import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { PlanLimits, UsageSummary } from "@rakazo/contracts";
import { modelCreditsUsd } from "@rakazo/contracts";
import { accountDisplay, formatTimeUntil } from "@rakazo/core";
import type { Href } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppMark } from "../../components/app-mark";
import { ApprovalModeRow, ApprovalRulesRow } from "../../components/approval-settings-rows";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow, useStackedSettings } from "../../components/settings-group";
import { SpendingLimitRow, useSpendingStatus } from "../../components/spending-limit-row";
import { rpc, selectedSpaceId } from "../../lib/api";
import { signOut } from "../../lib/api-auth";
import { formatUpdateLabel, getAppVersionInfo } from "../../lib/app-version";
import { useApprovalSettings } from "../../lib/approval-settings";
import { replaceWithSignIn } from "../../lib/auth-routing";
import { endCallBeforeSessionEnd } from "../../lib/call-session";
import { dateLocaleForUi, useUiLocale } from "../../lib/i18n";
import type { MobileMe } from "../../lib/mobile-types";
import { native, useMobileTokens, useThemedStyles } from "../../lib/native";
import { activeOrganization, useOrganizations } from "../../lib/organizations";
import { createSettingsPageStyles } from "../../lib/settings-page-styles";
import { isSettingsLink, openFromSettingsSheet } from "../../lib/settings-sheet";
import { ACCOUNT_SETTINGS } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { openStoreListing, useStoreUpdateAvailable } from "../../lib/store-update";
import { confirmUnsentSendLoss } from "../../lib/unsent-send-warning";
import { errorText } from "../../lib/user-error";

type Icon = Pick<ComponentProps<typeof NativeSymbol>, "ios" | "android">;
type SettingsLink = { title: string; href: Href; icon: Icon };

/** The settings hub: the account, then shortcuts, settings and admin, each one row deep. */
export default function Account() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const locale = useUiLocale();
  const router = useRouter();
  const tokens = useMobileTokens();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const [me, setMe] = useState<MobileMe | null>(null);
  const account = accountDisplay(me ?? {}, t`Your account`);
  const [signingOut, setSigningOut] = useState(false);
  // Held from the tap, so a second tap while the unsent-message check runs starts nothing.
  const signOutStarted = useRef(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  // Subscription allowances and a credit balance show only for members who have them.
  const [plans, setPlans] = useState<PlanLimits[]>([]);
  const [creditsUsd, setCreditsUsd] = useState<number | null>(null);
  // Messaging appears only on servers that have a chat app connected, as on web.
  const [messagingEnabled, setMessagingEnabled] = useState(false);
  const stacked = useStackedSettings();
  const styles = useThemedStyles(createAccountStyles);
  const versionInfo = getAppVersionInfo();
  const updateLabel = formatUpdateLabel(versionInfo.update);
  const versionAccessibility = [versionInfo.nativeLabel, updateLabel].filter(Boolean).join(". ");
  const storeUpdateAvailable = useStoreUpdateAvailable();
  const approvals = useApprovalSettings(ACCOUNT_SETTINGS);
  const spending = useSpendingStatus();
  const organizations = useOrganizations().data;

  const icon = ({ ios, android }: Icon) => (
    <NativeSymbol ios={ios} android={android} color={tokens.mutedForeground} />
  );
  const settingsLink = ({ title, href, icon: glyph }: SettingsLink) => (
    <SettingsRow
      key={typeof href === "string" ? href : href.pathname}
      accessibilityRole="button"
      chevron="right"
      disabled={signingOut}
      leading={icon(glyph)}
      // Artifacts, Board and Members live on the root stack, so they close the sheet first.
      onPress={() =>
        typeof href === "string" && isSettingsLink(href)
          ? router.push(href)
          : openFromSettingsSheet(router, href)
      }
      title={title}
    />
  );

  // Read on every visit, so a name changed on the Account page shows on return.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void rpc("me")
        .then((next) => {
          if (active) setMe(next);
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, []),
  );

  useEffect(() => {
    void rpc("usage/summary")
      .then(setUsage)
      .catch(() => undefined);
    void rpc("usage/limits")
      .then(setPlans)
      .catch(() => undefined);
    void rpc("billing/status")
      .then((status) => setCreditsUsd(modelCreditsUsd(status)))
      .catch(() => undefined);
  }, []);

  // Checked on every visit, so a failed check never hides Messaging for good.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void rpc("messaging/status")
        .then((status) => {
          if (active) setMessagingEnabled(status.enabled);
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, []),
  );

  const count = new Intl.NumberFormat(dateLocaleForUi(locale));
  const usd = new Intl.NumberFormat(dateLocaleForUi(locale), {
    style: "currency",
    currency: "USD",
  });
  const tokenCount = (value: number | null | undefined) =>
    value == null ? "—" : count.format(value);
  const cost = (value: number | null | undefined) =>
    value == null
      ? undefined
      : value > 0 && value < 0.01
        ? `<${usd.format(0.01)}`
        : usd.format(value);
  const usageBlock = (
    <SettingsRow
      key="usage"
      accessible
      title={t`Usage`}
      detail={
        usage
          ? t`${ph({ runs: count.format(usage.runs) })} runs, ${ph({ tokens: tokenCount(usage.totalTokens) })} tokens`
          : undefined
      }
      value={cost(usage?.costUsd)}
    />
  );
  const creditsRow =
    creditsUsd !== null ? (
      <SettingsRow
        key="credits"
        accessible
        title={t`Credits`}
        value={t`${ph({ amount: usd.format(creditsUsd) })} left`}
      />
    ) : null;
  const period = { session: t`Session`, week: t`Weekly`, month: t`Monthly` };
  const planGroups = plans.map((plan) => (
    <SettingsGroup
      key={plan.credentialId}
      label={plan.label === plan.name ? plan.name : `${plan.name} · ${plan.label}`}
    >
      {plan.windows.map((window) => {
        const reset = formatTimeUntil(window.resetsAt, dateLocaleForUi(locale));
        return (
          <SettingsRow
            key={window.period}
            accessible
            title={period[window.period]}
            detail={reset ? t`Resets in ${ph({ reset })}` : undefined}
            value={t`${ph({ used: Math.round(window.usedPercent) })}% used`}
          />
        );
      })}
    </SettingsGroup>
  ));
  const usageModels = usage?.models?.length ? (
    <SettingsGroup>
      {usage.models.map((row) => (
        <SettingsRow
          key={`${row.provider}:${row.model}`}
          accessible
          title={row.model}
          detail={`${row.provider}, ${t`${ph({ calls: count.format(row.modelCalls) })} calls, ${ph({ tokens: tokenCount(row.totalTokens) })} tokens`}`}
          value={cost(row.costUsd)}
        />
      ))}
    </SettingsGroup>
  ) : null;

  async function handleSignOut() {
    if (signOutStarted.current) return;
    signOutStarted.current = true;
    if (!(await confirmUnsentSendLoss("sign-out"))) {
      signOutStarted.current = false;
      return;
    }
    setSigningOut(true);
    setSignOutError(null);
    try {
      // Hang up while the session still exists, so the server records the call's end.
      await endCallBeforeSessionEnd();
      await signOut();
      replaceWithSignIn();
    } catch (err) {
      setSignOutError(errorText(err, t`Could not sign out`));
      setSigningOut(false);
      signOutStarted.current = false;
    }
  }

  const shortcuts: SettingsLink[] = [
    {
      title: t`Integrations`,
      href: "/integrations",
      icon: { ios: "puzzlepiece.extension", android: "extension-puzzle-outline" },
    },
    {
      title: t`Skills`,
      href: "/skills",
      icon: { ios: "scroll", android: "document-text-outline" },
    },
    {
      title: t`Artifacts`,
      href: "/artifacts",
      icon: { ios: "folder", android: "folder-outline" },
    },
    ...(me?.ticketBoardEnabled
      ? [
          {
            title: t`Board`,
            href: "/board",
            icon: { ios: "rectangle.split.3x1", android: "grid-outline" },
          } as const,
        ]
      : []),
  ];

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={[styles.content, stacked && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
      >
        {focus === "usage" ? (
          <>
            <SettingsGroup>
              {usageBlock}
              {creditsRow}
            </SettingsGroup>
            {planGroups}
            {usageModels}
          </>
        ) : null}
        <SettingsGroup>
          <SettingsRow
            key="profile"
            accessibilityRole="button"
            chevron="right"
            detail={me?.email && account.label !== me.email ? me.email : undefined}
            prominent
            title={account.label}
            onPress={() => router.push("/profile")}
          />
          {focus !== "usage" ? usageBlock : null}
          {focus !== "usage" ? creditsRow : null}
        </SettingsGroup>
        {focus !== "usage" ? planGroups : null}

        <SettingsGroup>{shortcuts.map(settingsLink)}</SettingsGroup>

        <SettingsGroup>
          {[
            {
              title: t`General`,
              href: "/general",
              icon: { ios: "gearshape", android: "settings-outline" },
            } as const,
            {
              title: t`Models`,
              href: "/models",
              icon: { ios: "cpu", android: "hardware-chip-outline" },
            } as const,
          ].map(settingsLink)}
          <ApprovalModeRow
            key="approvals"
            approvals={approvals}
            disabled={signingOut}
            leading={icon({ ios: "checkmark.shield", android: "shield-checkmark-outline" })}
          />
          {approvals.ruleCount ? (
            <ApprovalRulesRow
              key="approval-rules"
              count={approvals.ruleCount}
              disabled={signingOut}
              leading={icon({ ios: "list.bullet", android: "list-outline" })}
              onPress={() => router.push("/approvals")}
            />
          ) : null}
          {settingsLink({
            title: t`Vault`,
            href: "/vault",
            icon: { ios: "key", android: "key-outline" },
          })}
          {me?.paymentWalletProvider
            ? settingsLink({
                title: t`Wallet`,
                href: "/wallet",
                icon: { ios: "wallet.pass", android: "wallet-outline" },
              })
            : null}
          {spending?.shown ? (
            <SpendingLimitRow
              key="spending-limit"
              status={spending}
              disabled={signingOut}
              leading={icon({ ios: "dollarsign.circle", android: "cash-outline" })}
            />
          ) : null}
          {[
            {
              title: t`Memory`,
              href: "/memory",
              icon: { ios: "brain", android: { material: "brain" } },
            } as const,
            {
              title: t`Voice`,
              href: "/voice",
              icon: { ios: "speaker.wave.2", android: "volume-high-outline" },
            } as const,
            ...(messagingEnabled
              ? [
                  {
                    title: t`Messaging`,
                    href: "/messaging",
                    icon: { ios: "message", android: "chatbubble-outline" },
                  } as const,
                ]
              : []),
          ].map(settingsLink)}
        </SettingsGroup>

        <SettingsGroup>
          {organizations ? (
            <SettingsRow
              key="organization"
              accessibilityRole="button"
              chevron="right"
              leading={icon({ ios: "building.2", android: "business-outline" })}
              onPress={() => router.push("/organization")}
              title={t`Organization`}
              value={activeOrganization(organizations)?.name}
            />
          ) : null}
          {me
            ? settingsLink({
                title: t`Members`,
                // The space header holds Members too, but a single space has no header.
                href: {
                  pathname: "/space-members",
                  params: { spaceId: selectedSpaceId() ?? me.spaceId },
                },
                icon: { ios: "person.2", android: "people-outline" },
              })
            : null}
          {me?.billingEnabled
            ? settingsLink({
                title: t`Billing`,
                href: "/billing",
                icon: { ios: "creditcard", android: "card-outline" },
              })
            : null}
        </SettingsGroup>

        <View style={styles.section}>
          <NativeActionButton
            disabled={signingOut}
            fill
            label={t`Sign out`}
            onPress={() => void handleSignOut()}
            prominence="secondary"
          />
          {signOutError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {signOutError}
            </Text>
          ) : null}
        </View>

        <View style={styles.about}>
          <AppMark />
          {versionInfo.nativeLabel || updateLabel ? (
            <View
              accessibilityLabel={versionAccessibility}
              accessibilityRole="summary"
              style={styles.versionFooter}
            >
              {versionInfo.nativeLabel ? (
                <Text style={styles.versionLine}>{versionInfo.nativeLabel}</Text>
              ) : null}
              {updateLabel ? <Text style={styles.versionLine}>{updateLabel}</Text> : null}
            </View>
          ) : null}
          {storeUpdateAvailable ? (
            <NativeActionButton
              label={t`Update`}
              onPress={openStoreListing}
              prominence="secondary"
              size="compact"
              style={styles.updateButton}
            />
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function createAccountStyles() {
  return StyleSheet.create({
    ...createSettingsPageStyles(),
    about: {
      alignItems: "center",
      gap: 16,
      paddingTop: 8,
      paddingBottom: 22,
    },
    versionFooter: {
      alignItems: "center",
    },
    updateButton: {
      alignSelf: "center",
    },
    versionLine: {
      color: native.secondaryLabel,
      fontSize: 13,
      textAlign: "center",
    },
  });
}
