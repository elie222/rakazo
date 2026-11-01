import type { StyleProp, ViewStyle } from "react-native";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";
import { RunErrorAction } from "./run-error-actions";

/** A list item: its full height participates in scrolling above the composer. */
export function ThreadErrorNotice({
  error,
  summary,
  resetAt,
  onDetails,
  action,
}: {
  error: string | null;
  summary: string | null;
  resetAt?: number;
  onDetails?: () => void;
  /** The one action that fixes the failure. */
  action?: { label: string; onPress: () => void } | null;
}) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const { fontScale } = useWindowDimensions();
  if (!error && !summary) return null;
  const upcomingReset =
    resetAt && resetAt > Date.now()
      ? t("Resets {date}.", {
          date: new Intl.DateTimeFormat(locale, {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          }).format(resetAt),
        })
      : null;
  const hasBody = (summary && error) || upcomingReset || action || (summary && onDetails);
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={[styles.card, { backgroundColor: tokens.card }]}
    >
      <View style={styles.header}>
        <View
          style={{
            width: 18 * fontScale,
            paddingTop: Math.max(0, (20 * fontScale - 15 * fontScale) / 2),
          }}
        >
          <NativeSymbol
            ios="exclamationmark.triangle.fill"
            android="warning"
            size={15 * fontScale}
            color={tokens.warning}
          />
        </View>
        <Text style={[styles.headline, { color: tokens.foreground }]}>{summary ?? error}</Text>
      </View>
      {hasBody ? (
        <View style={[styles.body, { marginLeft: 18 * fontScale + 8 }]}>
          {summary && error ? (
            <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{error}</Text>
          ) : null}
          {upcomingReset ? (
            <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{upcomingReset}</Text>
          ) : null}
          {action ? <RunErrorAction label={action.label} onPress={action.onPress} /> : null}
          {summary && onDetails ? (
            <Pressable
              accessibilityRole="link"
              onPress={onDetails}
              hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
              style={styles.details}
            >
              <Text style={{ color: tokens.link, fontSize: 14, fontWeight: "600" }}>
                {t("Details")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A failed fetch, kept above the composer and outside both message lists. */
export function ThreadFetchErrorNotice({
  error,
  showingSaved,
  style,
}: {
  error: string | null;
  showingSaved: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <View style={[{ paddingBottom: 24 }, style]}>
      <ThreadErrorNotice
        error={showingSaved ? t("Couldn't refresh — showing the last loaded messages.") : error}
        summary={null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Fill only: cards in the thread read by tone, without an outline.
  card: { borderRadius: 12, padding: 16, marginTop: 12, gap: 6 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  headline: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  body: { marginLeft: 26, gap: 12 },
  details: { alignSelf: "flex-start" },
});
