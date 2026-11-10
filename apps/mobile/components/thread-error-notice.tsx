import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { customErrorTextStyle, useCustomSettings } from "../lib/custom-settings";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";
import { RunErrorAction, RunErrorTextAction } from "./run-error-actions";

/** A list item: its full height participates in scrolling above the composer. */
export function ThreadErrorNotice({
  error,
  summary,
  resetAt,
  onDetails,
  action,
  userId,
}: {
  error: string | null;
  summary: string | null;
  resetAt?: number;
  onDetails?: () => void;
  /** The one action that fixes the failure. */
  action?: { label: string; onPress: () => void } | null;
  /** The account whose interface settings style the error text. */
  userId?: string;
}) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const { fontScale } = useWindowDimensions();
  const customSettings = useCustomSettings(userId ?? "");
  const errorStyle = customErrorTextStyle(customSettings);
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
      style={[
        styles.card,
        { backgroundColor: customSettings.messageBackgrounds.error ?? native.fill },
      ]}
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
        <Text
          style={[
            styles.headline,
            { color: errorStyle.color ?? tokens.foreground },
            { fontSize: errorStyle.fontSize, lineHeight: errorStyle.lineHeight },
            ...(errorStyle.fontFamily ? [{ fontFamily: errorStyle.fontFamily }] : []),
          ]}
        >
          {summary ?? error}
        </Text>
      </View>
      {hasBody ? (
        <View style={[styles.body, { marginLeft: 18 * fontScale + 8 }]}>
          {summary && error ? (
            <Text style={[errorStyle, { color: errorStyle.color ?? tokens.mutedForeground }]}>
              {error}
            </Text>
          ) : null}
          {upcomingReset ? (
            <Text style={[errorStyle, { color: errorStyle.color ?? tokens.mutedForeground }]}>
              {upcomingReset}
            </Text>
          ) : null}
          {action ? <RunErrorAction label={action.label} onPress={action.onPress} /> : null}
          {summary && onDetails ? (
            <RunErrorTextAction label={t("Details")} onPress={onDetails} />
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
  userId,
}: {
  error: string | null;
  showingSaved: boolean;
  /** The account whose interface settings style the error text. */
  userId?: string;
}) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <View style={{ paddingBottom: 24 }}>
      <ThreadErrorNotice
        error={showingSaved ? t("Couldn't refresh — showing the last loaded messages.") : error}
        summary={null}
        userId={userId}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Fill only: cards in the thread read by tone, without an outline.
  card: { borderRadius: 18, padding: 16, marginTop: 12, gap: 6 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  headline: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  body: { marginLeft: 26, gap: 12 },
});
