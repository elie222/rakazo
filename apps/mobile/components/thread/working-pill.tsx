import { useLingui } from "@lingui/react/macro";
import { typeScale } from "@rakazo/ui-tokens";
import { Alert, StyleSheet, Text, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { native, useThemedStyles } from "../../lib/native/native";
import { useSave } from "../../lib/query/query";
import { GlassSurface } from "../native/glass-surface";
import { NativeActionButton } from "../native/native-action-button";

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    pill: {
      marginTop: 8,
      borderRadius: 999,
      minHeight: 44,
      paddingStart: 16,
      paddingEnd: 6,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    fallback: {
      borderWidth: 1,
      borderColor: tokens.glassStroke,
      backgroundColor: tokens.glassFill,
    },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.workingDot },
    label: { flex: 1, color: native.label, ...typeScale.secondary },
    // The native button aligns itself to the top of a row unless told otherwise.
    stop: { alignSelf: "center" },
  });
}

/**
 * What the chat is doing right now, on glass above the composer, with a way to stop it. Stop ends
 * every run in the chat, so a group that also has a bot waiting on the person leaves it out.
 */
export function WorkingPill({
  label,
  target,
  canStop,
}: {
  label: string;
  target: { botId: string } | { groupId: string };
  canStop: boolean;
}) {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const stop = useSave<void>({
    save: (_input, send) => send("threads/stop", target),
    onFailed: (error) => Alert.alert(t`Could not stop`, errorText(error, t`Try again.`)),
  });
  return (
    <GlassSurface style={styles.pill} fallbackStyle={styles.fallback}>
      <View accessibilityElementsHidden style={styles.dot} />
      <Text accessibilityRole="text" numberOfLines={1} style={styles.label}>
        {label}
      </Text>
      {canStop ? (
        <NativeActionButton
          label={t`Stop`}
          prominence="secondary"
          size="compact"
          style={styles.stop}
          busy={stop.pending}
          onPress={() => stop.run()}
        />
      ) : null}
    </GlassSurface>
  );
}
