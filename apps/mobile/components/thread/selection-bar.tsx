import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Pressable, Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";
import { GlassSurface } from "../native/glass-surface";

/** Replaces the composer while messages are being chosen to copy together. */
export function SelectionBar({
  count,
  onCancel,
  onCopy,
}: {
  count: number;
  onCancel: () => void;
  onCopy: () => void;
}) {
  const { t } = useLingui();
  const tokens = mobileTokens();
  return (
    <GlassSurface
      style={{
        marginTop: 12,
        borderRadius: 999,
        paddingHorizontal: 20,
        paddingVertical: 8,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
      fallbackStyle={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor: tokens.glassStroke,
        backgroundColor: tokens.glassFill,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t`Cancel`}
        hitSlop={8}
        onPress={onCancel}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 17 }}>{t`Cancel`}</Text>
      </Pressable>
      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ color: tokens.mutedForeground, fontSize: 15 }}>
          {t`${plural(count, { one: "# selected", other: "# selected" })}`}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t`Copy`}
        accessibilityState={{ disabled: count === 0 }}
        disabled={count === 0}
        hitSlop={8}
        onPress={onCopy}
        style={{ minHeight: 44, justifyContent: "center", opacity: count === 0 ? 0.4 : 1 }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 17, fontWeight: "600" }}>{t`Copy`}</Text>
      </Pressable>
    </GlassSurface>
  );
}
