import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { ViewStyle } from "react-native";
import { ActivityIndicator, Pressable, View } from "react-native";
import type { ComposerDictationStatus } from "../../lib/composer/composer-dictation";
import { useMobileTokens } from "../../lib/native/native";
import { GlassSurface } from "../native/glass-surface";
import { NativeSymbol } from "../native/native-symbol";

const BAR_WIDTH = 3;
const BAR_GAP = 3;
const MAX_HEIGHT = 20;

type LevelSource = (listener: (level: number) => void) => () => void;

/** The composer's controls while it dictates: discard, the live mic level, stop, then `children`. */
export function DictationBar({
  status,
  onLevel,
  onCancel,
  onStop,
  pillStyle,
  children,
}: {
  status: Exclude<ComposerDictationStatus, "idle">;
  onLevel: LevelSource;
  onCancel: () => void;
  onStop: () => void;
  pillStyle: ViewStyle;
  children: ReactNode;
}) {
  const tokens = useMobileTokens();
  const { t } = useLingui();
  const transcribing = status === "transcribing";
  // The 44-point tap target iOS asks for around each circle.
  const hitSlop = (44 - Number(pillStyle.width)) / 2;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t`Cancel dictation`}
        hitSlop={hitSlop}
        onPress={onCancel}
      >
        <GlassSurface style={pillStyle} fallbackStyle={{ backgroundColor: tokens.muted }}>
          <NativeSymbol ios="xmark" android="close" size={15} color={tokens.foreground} />
        </GlassSurface>
      </Pressable>
      {transcribing ? <View style={{ flex: 1 }} /> : <DictationLevels onLevel={onLevel} />}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t`Stop dictating`}
        disabled={transcribing}
        hitSlop={hitSlop}
        onPress={onStop}
      >
        <GlassSurface style={pillStyle} fallbackStyle={{ backgroundColor: tokens.muted }}>
          {transcribing ? (
            <ActivityIndicator size="small" color={tokens.foreground} />
          ) : (
            <NativeSymbol ios="stop.fill" android="stop" size={13} color={tokens.foreground} />
          )}
        </GlassSurface>
      </Pressable>
      {children}
    </View>
  );
}

/**
 * The microphone's recent loudness as a row of bars, newest on the trailing end; the slots not
 * yet heard are dots, so a silent mic still shows it is open.
 */
function DictationLevels({ onLevel }: { onLevel: LevelSource }) {
  const tokens = useMobileTokens();
  const [slots, setSlots] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  useEffect(
    () =>
      onLevel((level) => {
        setLevels((previous) => [...previous, level].slice(-Math.max(slots, 1)));
      }),
    [onLevel, slots],
  );
  const shown = levels.slice(-slots);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(event) =>
        setSlots(Math.floor((event.nativeEvent.layout.width + BAR_GAP) / (BAR_WIDTH + BAR_GAP)))
      }
      style={{
        flex: 1,
        height: MAX_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: BAR_GAP,
        overflow: "hidden",
      }}
    >
      {Array.from({ length: slots }, (_, index) => {
        const level = shown[index - (slots - shown.length)];
        return (
          <View
            key={index}
            style={{
              width: BAR_WIDTH,
              height: level === undefined ? BAR_WIDTH : Math.max(BAR_WIDTH, level * MAX_HEIGHT),
              borderRadius: BAR_WIDTH / 2,
              backgroundColor: level === undefined ? tokens.faintForeground : tokens.foreground,
            }}
          />
        );
      })}
    </View>
  );
}
