import { useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import { memo, useState } from "react";
import type { ViewStyle } from "react-native";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import Animated, { Easing, useAnimatedStyle, withTiming } from "react-native-reanimated";
import type { ComposerDictationStatus } from "../../lib/composer/composer-dictation";
import { DICTATION_LEVEL_COUNT } from "../../lib/composer/dictation-levels";
import { useMobileTokens } from "../../lib/native/native";
import { GlassSurface } from "../native/glass-surface";
import { NativeSymbol } from "../native/native-symbol";

const BAR_HEIGHT = 28;
const BAR_MIN_HEIGHT = 2;
const BAR_SPACING = 5;
const BAR_TIMING = { duration: 100, easing: Easing.out(Easing.quad) };

const WaveformBar = memo(function WaveformBar({
  levels,
  index,
  color,
}: {
  levels: SharedValue<readonly number[]>;
  index: number;
  color: string;
}) {
  const style = useAnimatedStyle(() => {
    const level = levels.value[index] ?? 0;
    return {
      opacity: withTiming(0.22 + level * 0.78, BAR_TIMING),
      transform: [
        {
          scaleY: withTiming(
            (BAR_MIN_HEIGHT + level * (BAR_HEIGHT - BAR_MIN_HEIGHT)) / BAR_HEIGHT,
            BAR_TIMING,
          ),
        },
      ],
    };
  });
  return (
    <Animated.View
      style={[{ width: 2, height: BAR_HEIGHT, borderRadius: 1, backgroundColor: color }, style]}
    />
  );
});

function Waveform({ levels, color }: { levels: SharedValue<readonly number[]>; color: string }) {
  const [count, setCount] = useState(0);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(event) =>
        setCount(
          Math.max(
            1,
            Math.min(
              DICTATION_LEVEL_COUNT,
              Math.floor(event.nativeEvent.layout.width / BAR_SPACING),
            ),
          ),
        )
      }
      style={{
        flex: 1,
        minWidth: 0,
        height: BAR_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        overflow: "hidden",
      }}
    >
      {Array.from({ length: count }, (_, bar) => (
        <WaveformBar
          key={bar}
          levels={levels}
          index={DICTATION_LEVEL_COUNT - count + bar}
          color={color}
        />
      ))}
    </View>
  );
}

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The message box while dictating, as T3 Code shows it: cancel, the microphone's level and the
 * time so far, and finish. The words arrive in the box once the recording is transcribed.
 */
export function DictationBar({
  status,
  startedAt,
  levels,
  pillStyle,
  height,
  onCancel,
  onFinish,
}: {
  status: Exclude<ComposerDictationStatus, "idle">;
  startedAt: number | null;
  levels: SharedValue<readonly number[]>;
  pillStyle: ViewStyle;
  /** One line of the message box, so the bar keeps its height. */
  height: number;
  onCancel: () => void;
  onFinish: () => void;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const recording = status === "listening";
  const now = useNow(recording ? 1000 : null);
  const busyLabel = status === "preparing" ? t`Preparing dictation` : t`Transcribing`;
  return (
    <View style={{ flex: 1, height, flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t`Cancel dictation`}
        hitSlop={8}
        onPress={onCancel}
      >
        <NativeSymbol ios="xmark" android="close" size={15} color={tokens.mutedForeground} />
      </Pressable>
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          opacity: recording ? 1 : 0.4,
        }}
      >
        <Waveform levels={levels} color={tokens.foreground} />
        <Text
          style={{
            color: tokens.mutedForeground,
            fontSize: 13,
            fontVariant: ["tabular-nums"],
          }}
        >
          {elapsedLabel(startedAt === null ? 0 : now - startedAt)}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={recording ? t`Finish dictation` : busyLabel}
        accessibilityState={{ busy: !recording, disabled: !recording }}
        disabled={!recording}
        hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        onPress={onFinish}
      >
        <GlassSurface
          tint={tokens.primary}
          style={pillStyle}
          fallbackStyle={{ backgroundColor: tokens.primary }}
        >
          {recording ? (
            <NativeSymbol
              ios="checkmark"
              android="checkmark"
              size={15}
              color={tokens.primaryForeground}
            />
          ) : (
            <ActivityIndicator size="small" color={tokens.primaryForeground} />
          )}
        </GlassSurface>
      </Pressable>
    </View>
  );
}
