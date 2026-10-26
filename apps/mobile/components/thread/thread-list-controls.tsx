import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import type { ActivityMarkBot } from "../activity-mark";
import { ActivityMark } from "../activity-mark";
import { ScrollToBottomButton } from "../scroll-to-bottom-button";

/** The bots still working on a reply, under the newest message. */
export function ThreadWorkingFooter({
  bots,
  label,
  atBottom,
}: {
  bots: ReadonlyArray<ActivityMarkBot & { name?: string }>;
  label: string;
  atBottom: boolean;
}) {
  const { t } = useI18n();
  if (bots.length === 0) return null;
  return (
    <View
      accessibilityLabel={
        bots.length === 1
          ? t("{name} is working", { name: bots[0]?.name ?? t("Agent") })
          : t("{count} agents working", { count: bots.length })
      }
      accessibilityRole="text"
      style={{ minHeight: 40, marginTop: 12, justifyContent: "center" }}
    >
      <ActivityMark bots={bots} atBottom={atBottom} label={label} />
    </View>
  );
}

export function LoadEarlierButton({ loading, onPress }: { loading: boolean; onPress: () => void }) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  return (
    <Pressable
      disabled={loading}
      onPress={onPress}
      style={{
        alignSelf: "center",
        alignItems: "center",
        flexDirection: "row",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      {loading ? (
        <ActivityIndicator color={tokens.mutedForeground} accessibilityLabel={t("Loading…")} />
      ) : null}
      <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
        {t("Load earlier messages")}
      </Text>
    </Pressable>
  );
}

/** Floats over the list's corner, with a dot while newer messages wait below. */
export function JumpToLatestButton({ unread, onPress }: { unread: boolean; onPress: () => void }) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  return (
    <View style={{ position: "absolute", end: 0, bottom: 12 }}>
      <ScrollToBottomButton
        accessibilityLabel={unread ? t("Jump to latest, new messages") : t("Jump to latest")}
        onPress={onPress}
      />
      {unread ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 3,
            end: 3,
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: tokens.primary,
          }}
        />
      ) : null}
    </View>
  );
}
