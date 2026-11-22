import { avatarSharedTimeMs, LOGO_AVATAR_LOOP_MS } from "@rakazo/core";
import { useEffect } from "react";
import {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

/**
 * Native UI-thread clock read from the shared avatar clock, so every copy of a bot's
 * avatar, here or on the web, is at the same point in its loop. Each track completes
 * whole cycles in the loop, so restarting it at the same remainder never jumps.
 */
export function useLogoAvatarClock(running: boolean) {
  const milliseconds = useSharedValue(0);
  useEffect(() => {
    if (!running) return;
    const base = avatarSharedTimeMs() % LOGO_AVATAR_LOOP_MS;
    milliseconds.value = base;
    milliseconds.value = withRepeat(
      withTiming(base + LOGO_AVATAR_LOOP_MS, {
        duration: LOGO_AVATAR_LOOP_MS,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );
    return () => cancelAnimation(milliseconds);
  }, [running, milliseconds]);
  return milliseconds;
}
