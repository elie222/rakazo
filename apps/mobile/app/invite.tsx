import { DEFAULT_NEW_BOT_AVATAR_SET, INVITED_TRIAL_WEEKS } from "@rakazo/contracts";
import { INVITE_AVATAR_COLORS } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSymbol } from "../components/native-symbol";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";
import { useReferral } from "../lib/referral";

const AVATAR_SIZES = [44, 52, 64, 52, 44];

/** The invite sheet the chat's gift opens: what the friend and the owner each get, and the link. */
export default function InviteScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const referral = useReferral();

  useEffect(() => {
    if (!referral && router.canGoBack()) router.back();
  }, [referral, router]);
  if (!referral) return null;

  const rewards =
    referral.rewards === 0
      ? null
      : referral.rewards === 1
        ? t("1 free month earned")
        : t("{count} free months earned", { count: referral.rewards });
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View
        style={styles.avatars}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {AVATAR_SIZES.map((size, index) => (
          <BotAvatar
            key={INVITE_AVATAR_COLORS[index]}
            color={INVITE_AVATAR_COLORS[index]!}
            identity={`invite-${index}`}
            avatarSet={DEFAULT_NEW_BOT_AVATAR_SET}
            size={size}
          />
        ))}
      </View>
      <Text accessibilityRole="header" style={styles.title}>
        {t("Give a friend {weeks} weeks free", { weeks: INVITED_TRIAL_WEEKS })}
      </Text>
      <View style={styles.rows}>
        <View style={styles.row}>
          <NativeSymbol
            ios="gift"
            android="gift-outline"
            size={22}
            color={tokens.mutedForeground}
          />
          <Text style={styles.rowText}>
            {t("They get {weeks} weeks free.", { weeks: INVITED_TRIAL_WEEKS })}
          </Text>
        </View>
        <View style={styles.row}>
          <NativeSymbol
            ios="calendar.badge.plus"
            android="calendar-outline"
            size={22}
            color={tokens.mutedForeground}
          />
          <Text style={styles.rowText}>
            {t("You get a free month when they start their trial with a new card.")}
          </Text>
        </View>
      </View>
      {rewards ? <Text style={styles.rewards}>{rewards}</Text> : null}
      <NativeActionButton
        label={t("Share link")}
        onPress={() => void Share.share({ message: referral.url }).catch(() => undefined)}
      />
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { paddingHorizontal: 24, paddingTop: 32, paddingBottom: 24, gap: 24 },
    avatars: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
    title: { ...typeScale.title, color: native.label, textAlign: "center" },
    rows: { gap: 16 },
    row: { flexDirection: "row", alignItems: "center", gap: 14 },
    rowText: { ...typeScale.body, color: native.label, flexShrink: 1 },
    rewards: { ...typeScale.caption, color: native.secondaryLabel, textAlign: "center" },
  });
}
