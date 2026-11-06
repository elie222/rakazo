import { MenuView } from "@expo/ui/community/menu";
import type { BillingStatus, ByokInterval } from "@rakazo/contracts";
import {
  AI_PRIVACY_URL,
  DEFAULT_MONTHLY_CREDIT_AMOUNT,
  MODEL_CREDIT_AMOUNTS,
  ModelCreditAmountSchema,
} from "@rakazo/contracts";
import { botColors, botEyeColor, typeScale } from "@rakazo/ui-tokens";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccountDeletion } from "../components/account-deletion";
import { BotAvatar } from "../components/bot-avatar";
import { GlassIconButton } from "../components/glass-icon-button";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSegmentedControl } from "../components/native-segmented-control";
import { NativeSymbol } from "../components/native-symbol";
import { useOrganizationMenuAction } from "../components/organization-menu";
import { FORM_COLUMN_WIDTH } from "../lib/adaptive-layout";
import { rpc } from "../lib/api";
import { signOut } from "../lib/api-auth";
import { replaceWithSignIn } from "../lib/auth-routing";
import type { Plan } from "../lib/billing";
import {
  currentPlan,
  openBillingPage,
  ownKeyOffer,
  planEndsAt,
  purchaseCompleted,
  setPaywallShown,
  subscribedPlan,
} from "../lib/billing";
import { endCallBeforeSessionEnd } from "../lib/call-session";
import { translucentColor } from "../lib/color";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { organizationSwitchActions, useOrganizations } from "../lib/organizations";
import { confirmUnsentSendLoss } from "../lib/unsent-send-warning";
import { errorText } from "../lib/user-error";

type Amount = (typeof MODEL_CREDIT_AMOUNTS)[number];
type SymbolName = ComponentProps<typeof NativeSymbol>["android"];

const TERMS_URL = "https://rakazo.com/terms/";

// Bots carry the app's only colour, so the paywall's colour is a small crew of them.
const CREW = [
  { color: botColors[4], shape: 1, size: 40 },
  { color: botColors[0], shape: 3, size: 52 },
  { color: botColors[1], shape: 0, size: 64 },
  { color: botColors[3], shape: 2, size: 52 },
  { color: botColors[6], shape: 4, size: 40 },
];

/**
 * The plan choice. Shown over the app until the organization can run bots, and from Billing
 * (`?dismissible=1`) to pick a plan without leaving what was open.
 */
export default function Paywall() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const dismissible = useLocalSearchParams<{ dismissible?: string }>().dismissible === "1";
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [plan, setPlan] = useState<Plan>("byok");
  const [amount, setAmount] = useState<Amount>(DEFAULT_MONTHLY_CREDIT_AMOUNT);
  const [interval, setByokInterval] = useState<ByokInterval>("month");
  const [pending, setPending] = useState(false);
  const leaving = useRef(false);
  const deletion = useAccountDeletion();
  const organizations = useOrganizations(!dismissible).data;
  const organizationAction = useOrganizationMenuAction(organizations);
  useEffect(() => {
    if (deletion.error) Alert.alert(deletion.error);
  }, [deletion.error]);
  const [started, setStarted] = useState<Plan | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const planPicked = useRef(false);

  useEffect(() => {
    setPaywallShown(true);
    return () => setPaywallShown(false);
  }, []);

  // Android's back button would otherwise leave the paywall for an app that cannot run.
  useEffect(() => {
    if (dismissible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [dismissible]);

  const load = useCallback(() => {
    setLoadFailed(false);
    rpc("billing/status")
      .then((next) => {
        // Changing plans from Billing starts on the plan the organization is not on yet.
        if (!planPicked.current) {
          planPicked.current = true;
          if (
            dismissible &&
            currentPlan(next) === "byok" &&
            !next.byokFreeUntil &&
            next.creditPurchasesEnabled !== false
          )
            setPlan("credits");
        }
        setStatus(next);
        // Only the required paywall gives way once access lands (e.g. a Safari checkout);
        // from Billing, an organization that already has access is here to change plans.
        if (next.access && !dismissible)
          setStarted((current) => current ?? (next.funding === "credits" ? "credits" : "byok"));
      })
      .catch(() => setLoadFailed(true));
  }, [dismissible]);

  // Older binaries finish checkout in Safari, so look again when the app comes back.
  useEffect(() => {
    load();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") load();
    });
    return () => subscription.remove();
  }, [load]);

  async function choose() {
    if (!status || pending) return;
    setPending(true);
    try {
      const { url } =
        plan === "credits"
          ? await rpc("billing/purchaseCredits", {
              amountCents: amount,
              monthly: true,
              client: "mobile",
            })
          : status.byokFreeUntil
            ? await rpc("billing/checkout", { client: "mobile", interval })
            : await rpc("billing/selectFunding", { funding: "byok", client: "mobile", interval });
      const next = url ? await openBillingPage(url) : await rpc("billing/refresh");
      setStatus(next);
      if (purchaseCompleted(status, next)) setStarted(plan);
    } catch (err) {
      Alert.alert(errorText(err, t("Could not open billing")));
    } finally {
      setPending(false);
    }
  }

  async function leave() {
    // Held from the tap, so a second tap while the unsent-message check runs starts nothing.
    if (leaving.current) return;
    leaving.current = true;
    try {
      if (!(await confirmUnsentSendLoss("sign-out"))) return;
      // Hang up while the session still exists, so the server records the call's end.
      await endCallBeforeSessionEnd();
      await signOut();
      replaceWithSignIn();
    } catch (err) {
      Alert.alert(errorText(err, t("Could not sign out")));
    } finally {
      leaving.current = false;
    }
  }

  const topBar = (
    // A solid row, so scrolled content never slides under the status bar or this action.
    <View
      style={[
        styles.topBar,
        { paddingTop: insets.top, height: insets.top + 52, backgroundColor: tokens.background },
      ]}
    >
      {dismissible ? (
        <GlassIconButton
          accessibilityLabel={t("Close")}
          ios="xmark"
          android="close"
          onPress={() => router.back()}
        />
      ) : (
        <MenuView
          actions={[
            ...organizationSwitchActions(organizations),
            { id: "sign-out", title: t("Sign out") },
            { id: "delete", title: t("Delete account") },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (pending || deletion.pending) return;
            if (nativeEvent.event === "delete") void deletion.request();
            else if (nativeEvent.event === "sign-out") void leave();
            else organizationAction(nativeEvent.event);
          }}
        >
          <View
            accessible
            accessibilityLabel={t("Account")}
            accessibilityRole="button"
            style={styles.account}
          >
            <NativeSymbol
              ios="person.crop.circle"
              android="person-circle-outline"
              size={24}
              color={tokens.mutedForeground}
            />
          </View>
        </MenuView>
      )}
      {deletion.dialog}
    </View>
  );

  if (!status) {
    return (
      <View style={[styles.screen, { backgroundColor: tokens.background }]}>
        {topBar}
        <View style={[styles.screen, styles.center]}>
          {loadFailed ? (
            <View style={styles.failed}>
              <Text style={[styles.lead, { color: tokens.mutedForeground }]}>
                {t("Could not load billing")}
              </Text>
              <NativeActionButton label={t("Try again")} prominence="secondary" onPress={load} />
            </View>
          ) : (
            <ActivityIndicator color={tokens.mutedForeground} accessibilityLabel={t("Loading…")} />
          )}
        </View>
      </View>
    );
  }

  if (started) {
    const endsAt = planEndsAt(status);
    const freeUntil = endsAt
      ? new Date(endsAt).toLocaleDateString(dateLocaleForUi(), { month: "long", day: "numeric" })
      : null;
    return (
      <View
        style={[
          styles.screen,
          styles.center,
          { backgroundColor: tokens.background, paddingBottom: insets.bottom + 16 },
        ]}
      >
        <View style={styles.done}>
          <NativeSymbol
            ios="checkmark.circle.fill"
            android="checkmark-circle"
            size={64}
            color={tokens.success}
          />
          <Text accessibilityRole="header" style={[styles.title, { color: tokens.foreground }]}>
            {status.state === "trialing" ? t("Your free trial has started") : t("You're all set")}
          </Text>
          {status.state === "trialing" && freeUntil ? (
            <Text style={[styles.lead, { color: tokens.mutedForeground }]}>
              {t("Free until {date}", { date: freeUntil })}
            </Text>
          ) : null}
        </View>
        <View style={styles.footer}>
          <NativeActionButton
            label={started === "byok" ? t("Connect your AI") : t("Start using Rakazo")}
            onPress={() => {
              router.back();
              if (started === "byok") router.push("/models");
            }}
          />
        </View>
      </View>
    );
  }

  const offer = ownKeyOffer(status);
  // From Billing, the plan already paid for is marked and cannot be bought again.
  const subscribed = dismissible ? subscribedPlan(status) : null;
  const annualCents = status.byokPriceCents ? status.byokAnnualPriceCents : null;
  const yearly = interval === "year" && annualCents;
  const monthlyPrice = status.byokPriceCents ? `$${status.byokPriceCents / 100}` : null;
  const annualMonthlyPrice = annualCents ? `$${Math.round(annualCents / 12) / 100}` : null;
  // What the chosen plan bills each period, as the terms and trial timeline state it.
  const ownKeyPrice = yearly ? `$${yearly / 100}` : monthlyPrice;
  const creditPrice = `$${amount / 100}`;
  const features: { label: string; ios: string; android: SymbolName; color: string }[] = [
    {
      label: t("Bots with their own computer"),
      ios: "desktopcomputer",
      android: "desktop-outline",
      color: botColors[2],
    },
    {
      label: t("Routines that run while you're away"),
      ios: "clock.arrow.circlepath",
      android: "time-outline",
      color: botColors[5],
    },
    {
      label: t("Web, desktop and mobile apps"),
      ios: "iphone",
      android: "phone-portrait-outline",
      color: botColors[0],
    },
  ];
  const cta =
    plan === "credits" || offer === "subscribe"
      ? t("Subscribe")
      : offer === "trial"
        ? t("Start free trial")
        : t("Continue");
  const terms =
    plan === "credits"
      ? t("{price} / month. Cancel anytime.", { price: creditPrice })
      : offer === "trial" && ownKeyPrice
        ? yearly
          ? t("{days} days free, then {price} / year. Cancel anytime.", {
              days: status.trialDays,
              price: ownKeyPrice,
            })
          : t("{days} days free, then {price} / month. Cancel anytime.", {
              days: status.trialDays,
              price: ownKeyPrice,
            })
        : ownKeyPrice
          ? yearly
            ? t("{price} / year. Cancel anytime.", { price: ownKeyPrice })
            : t("{price} / month. Cancel anytime.", { price: ownKeyPrice })
          : null;

  return (
    <View style={[styles.screen, { backgroundColor: tokens.background }]}>
      {topBar}
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="never">
        <View style={styles.hero}>
          <View
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.crew}
          >
            {CREW.map((bot, index) => (
              <View
                key={bot.color}
                style={[styles.crewBot, { zIndex: index === 2 ? 2 : index % 2 }]}
              >
                <BotAvatar
                  color={`${bot.color}::shape_${bot.shape}`}
                  size={bot.size}
                  motion={index === 2 ? "live" : "static"}
                />
              </View>
            ))}
          </View>
          <Text accessibilityRole="header" style={[styles.title, { color: tokens.foreground }]}>
            {t("Put your bots to work")}
          </Text>
        </View>
        <View style={styles.features}>
          {features.map((feature) => (
            <View key={feature.label} style={styles.feature}>
              <View
                style={[
                  styles.featureIcon,
                  { backgroundColor: translucentColor(feature.color, 0.16) },
                ]}
              >
                <NativeSymbol
                  ios={feature.ios}
                  android={feature.android}
                  size={17}
                  color={feature.color}
                />
              </View>
              <Text style={[styles.featureLabel, { color: tokens.foreground }]}>
                {feature.label}
              </Text>
            </View>
          ))}
        </View>
        <View accessibilityRole="radiogroup" style={styles.plans}>
          <PlanCard
            selected={plan === "byok"}
            onPress={() => setPlan("byok")}
            title={t("Your subscription or API key")}
            price={
              monthlyPrice
                ? t("{price} / month", {
                    price: yearly && annualMonthlyPrice ? annualMonthlyPrice : monthlyPrice,
                  })
                : t("Free")
            }
            accessory={
              monthlyPrice && annualCents && status.byokPriceCents ? (
                <NativeSegmentedControl
                  accessibilityLabel={t("Billing period")}
                  value={interval}
                  onChange={(next) => {
                    setByokInterval(next);
                    setPlan("byok");
                  }}
                  options={[
                    { value: "month", label: t("Monthly") },
                    {
                      value: "year",
                      label: t("Yearly −{percent}%", {
                        percent: Math.round((1 - annualCents / (status.byokPriceCents * 12)) * 100),
                      }),
                    },
                  ]}
                />
              ) : undefined
            }
            detail={t("Works with your ChatGPT or Claude plan.")}
            badge={
              subscribed === "byok"
                ? t("Current plan")
                : offer === "trial"
                  ? t("{days} days free", { days: status.trialDays })
                  : undefined
            }
          />
          {status.creditPurchasesEnabled === false ? null : (
            <PlanCard
              selected={plan === "credits"}
              onPress={() => setPlan("credits")}
              title={t("Credits")}
              badge={subscribed === "credits" ? t("Current plan") : undefined}
              price={{
                label: t("{price} / month", { price: creditPrice }),
                control: (
                  <MenuView
                    actions={MODEL_CREDIT_AMOUNTS.map((value) => ({
                      id: String(value),
                      title: t("{price} / month", { price: `$${value / 100}` }),
                      state: amount === value ? ("on" as const) : ("off" as const),
                    }))}
                    onPressAction={({ nativeEvent }) => {
                      setAmount(ModelCreditAmountSchema.parse(Number(nativeEvent.event)));
                      setPlan("credits");
                    }}
                  >
                    <View
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel={t("{price} / month", { price: creditPrice })}
                      style={styles.amount}
                    >
                      <Text style={[styles.price, { color: tokens.foreground }]}>
                        {t("{price} / month", { price: creditPrice })}
                      </Text>
                      <NativeSymbol
                        ios="chevron.up.chevron.down"
                        android="chevron-expand"
                        size={12}
                        color={tokens.mutedForeground}
                      />
                    </View>
                  </MenuView>
                ),
              }}
              detail={t("All {price} goes to model usage.", { price: creditPrice })}
            />
          )}
        </View>
        {plan === "byok" && offer === "trial" && ownKeyPrice ? (
          <View style={styles.timeline}>
            <TimelineStep
              ios="lock.open.fill"
              android="lock-open"
              title={t("Today")}
              detail={t("Full access, nothing to pay")}
              color={botColors[0]}
              connected
            />
            <TimelineStep
              ios="creditcard.fill"
              android="card"
              title={t("Day {days}", { days: status.trialDays })}
              detail={
                yearly
                  ? t("{price} / year begins", { price: ownKeyPrice })
                  : t("{price} / month begins", { price: ownKeyPrice })
              }
            />
          </View>
        ) : null}
      </ScrollView>
      <View
        style={[
          styles.stickyFooter,
          {
            backgroundColor: tokens.background,
            borderTopColor: tokens.border,
            paddingBottom: insets.bottom + 8,
          },
        ]}
      >
        <View style={styles.footer}>
          {status.canManage ? (
            <>
              <NativeActionButton
                label={cta}
                busy={pending}
                disabled={plan === subscribed}
                onPress={() => void choose()}
              />
              {terms && plan !== subscribed ? (
                <Text style={[styles.terms, { color: tokens.mutedForeground }]}>{terms}</Text>
              ) : null}
            </>
          ) : (
            <Text style={[styles.terms, { color: tokens.mutedForeground }]}>
              {t("Only the owner of this account can choose a plan.")}
            </Text>
          )}
          <View style={styles.legal}>
            <LegalLink label={t("Terms")} url={TERMS_URL} />
            <LegalLink label={t("Privacy")} url={AI_PRIVACY_URL} />
          </View>
        </View>
      </View>
    </View>
  );
}

function PlanCard({
  selected,
  onPress,
  title,
  price,
  detail,
  badge,
  accessory,
}: {
  selected: boolean;
  onPress: () => void;
  title: string;
  /** Text, or a control that picks it with its text as the label read for the plan. */
  price: string | { label: string; control: ReactNode };
  detail: string;
  badge?: string;
  accessory?: ReactNode;
}) {
  const tokens = useMobileTokens();
  return (
    <View
      style={[
        styles.plan,
        {
          backgroundColor: tokens.card,
          borderColor: selected ? tokens.primary : tokens.border,
          borderWidth: selected ? 2 : 1,
          // The thicker border must not shift the content.
          padding: selected ? 15 : 16,
        },
      ]}
    >
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={[title, typeof price === "string" ? price : price.label, badge, detail]
          .filter(Boolean)
          .join(", ")}
        onPress={onPress}
        style={styles.planPress}
      >
        <View style={styles.planHeader}>
          <NativeSymbol
            ios={selected ? "checkmark.circle.fill" : "circle"}
            android={selected ? "checkmark-circle" : "ellipse-outline"}
            size={22}
            color={selected ? tokens.primary : tokens.faintForeground}
          />
          <Text style={[styles.planTitle, { color: tokens.foreground }]}>{title}</Text>
        </View>
        <View style={styles.planBody}>
          <View style={styles.priceRow}>
            {typeof price === "string" ? (
              <Text style={[styles.price, { color: tokens.foreground }]}>{price}</Text>
            ) : null}
            {badge ? (
              <View style={[styles.badge, { backgroundColor: tokens.primary }]}>
                <Text style={[styles.badgeLabel, { color: tokens.primaryForeground }]}>
                  {badge}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.planDetail, { color: tokens.mutedForeground }]}>{detail}</Text>
        </View>
      </Pressable>
      {/* Controls sit outside the radio, so VoiceOver can reach each one. */}
      {typeof price === "string" ? null : <View style={styles.planAccessory}>{price.control}</View>}
      {accessory ? <View style={styles.planAccessory}>{accessory}</View> : null}
    </View>
  );
}

function TimelineStep({
  ios,
  android,
  title,
  detail,
  color,
  connected = false,
}: {
  ios: string;
  android: SymbolName;
  title: string;
  detail: string;
  /** A bot colour for the free step; the paid step stays ink. */
  color?: string;
  connected?: boolean;
}) {
  const tokens = useMobileTokens();
  return (
    <View style={styles.step}>
      <View style={styles.stepRail}>
        <View style={[styles.stepIcon, { backgroundColor: color ?? tokens.primary }]}>
          <NativeSymbol
            ios={ios}
            android={android}
            size={13}
            color={color ? botEyeColor : tokens.primaryForeground}
          />
        </View>
        {connected ? <View style={[styles.stepLine, { backgroundColor: tokens.border }]} /> : null}
      </View>
      <View style={styles.stepText}>
        <Text style={[styles.stepTitle, { color: tokens.foreground }]}>{title}</Text>
        <Text style={[styles.planDetail, { color: tokens.mutedForeground }]}>{detail}</Text>
      </View>
    </View>
  );
}

function LegalLink({ label, url }: { label: string; url: string }) {
  const tokens = useMobileTokens();
  return (
    <Pressable accessibilityRole="link" hitSlop={8} onPress={() => void Linking.openURL(url)}>
      <Text style={[styles.legalLabel, { color: tokens.mutedForeground }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  topBar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  account: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  content: {
    width: "100%",
    maxWidth: FORM_COLUMN_WIDTH,
    alignSelf: "center",
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 24,
    gap: 28,
  },
  hero: { alignItems: "center", gap: 16 },
  title: { fontSize: 30, lineHeight: 36, fontWeight: "600", textAlign: "center" },
  lead: { ...typeScale.body, textAlign: "center" },
  features: { gap: 14 },
  feature: { flexDirection: "row", alignItems: "center", gap: 12 },
  crew: { flexDirection: "row", alignItems: "flex-end", justifyContent: "center", height: 68 },
  crewBot: { marginHorizontal: -5 },
  featureIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  featureLabel: { ...typeScale.body, flex: 1 },
  plans: { gap: 12 },
  plan: { borderRadius: 18, gap: 8 },
  planHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  planTitle: { ...typeScale.cardTitle, flex: 1 },
  planBody: { paddingLeft: 32, gap: 2 },
  planPress: { gap: 8 },
  planAccessory: { marginTop: 4, marginLeft: 32 },
  price: { fontSize: 22, lineHeight: 28, fontWeight: "600" },
  planDetail: typeScale.secondary,
  amount: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  priceRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  badge: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  badgeLabel: { ...typeScale.footnote, fontWeight: "600" },
  timeline: { paddingHorizontal: 4 },
  step: { flexDirection: "row", gap: 12 },
  stepRail: { alignItems: "center", width: 26 },
  stepIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  stepLine: { width: 2, flex: 1, minHeight: 18, marginVertical: 4 },
  stepText: { flex: 1, gap: 2, paddingBottom: 16 },
  stepTitle: { ...typeScale.body, fontWeight: "600" },
  footer: {
    gap: 10,
    width: "100%",
    maxWidth: FORM_COLUMN_WIDTH,
    alignSelf: "center",
    paddingHorizontal: 24,
  },
  stickyFooter: { paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  terms: { ...typeScale.caption, textAlign: "center" },
  legal: { flexDirection: "row", justifyContent: "center", gap: 24 },
  legalLabel: { ...typeScale.footnote, textDecorationLine: "underline" },
  failed: { alignItems: "center", gap: 14, paddingHorizontal: 32 },
  done: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, paddingHorizontal: 32 },
});
