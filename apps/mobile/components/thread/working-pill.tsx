import { useLingui } from "@lingui/react/macro";
import { typeScale } from "@rakazo/ui-tokens";
import { Alert, Text, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { native } from "../../lib/native/native";
import { useSave } from "../../lib/query/query";
import { GlassSurface } from "../native/glass-surface";
import { NativeActionButton } from "../native/native-action-button";

/** What the chat is doing right now, on glass above the composer, with a way to stop it. */
export function WorkingPill({
  label,
  target,
}: {
  label: string;
  target: { botId: string } | { groupId: string };
}) {
  const { t } = useLingui();
  const tokens = mobileTokens();
  const stop = useSave<void>({
    save: (_input, send) => send("threads/stop", target),
    onFailed: (error) => Alert.alert(t`Could not stop`, errorText(error, t`Try again.`)),
  });
  return (
    <GlassSurface
      style={{
        marginTop: 8,
        borderRadius: 999,
        minHeight: 44,
        paddingStart: 16,
        paddingEnd: 6,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
      fallbackStyle={{
        borderWidth: 1,
        borderColor: tokens.glassStroke,
        backgroundColor: tokens.glassFill,
      }}
    >
      <View
        accessibilityElementsHidden
        style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.workingDot }}
      />
      <Text
        accessibilityRole="text"
        numberOfLines={1}
        style={{ flex: 1, color: native.label, ...typeScale.secondary }}
      >
        {label}
      </Text>
      <NativeActionButton
        label={t`Stop`}
        prominence="secondary"
        size="compact"
        // The native button aligns itself to the top of a row unless told otherwise.
        style={{ alignSelf: "center" }}
        busy={stop.pending}
        onPress={() => stop.run()}
      />
    </GlassSurface>
  );
}
