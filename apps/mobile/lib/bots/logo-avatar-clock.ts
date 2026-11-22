import { useTimeout } from "@rakazo/chat-ui/hooks";
import { avatarSharedTimeMs, LOGO_AVATAR_LOOP_MS } from "@rakazo/core";
import { useEffect, useState } from "react";
import {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

/** How long one run of the clock lasts before it starts again from the shared clock. */
const RUN_MS = 24 * 60 * 60 * 1000;

/**
 * Native UI-thread clock read from the shared avatar clock, so every copy of a bot's
 * avatar, here or on the web, is at the same point in its loop. It is one long timing
 * rather than a repeating loop: each repeat starts on the frame that sees the last end,
 * so a late frame would leave that copy behind for good. Each track completes whole
 * cycles in the loop, so starting from the remainder never jumps.
 */
export function useLogoAvatarClock(running: boolean) {
  const milliseconds = useSharedValue(0);
  // Counts runs, so an avatar left on screen past one run starts another.
  const [run, setRun] = useState(0);
  useTimeout(() => setRun((count) => count + 1), running ? RUN_MS : null, run);
  useEffect(() => {
    if (!running) return;
    const base = avatarSharedTimeMs() % LOGO_AVATAR_LOOP_MS;
    milliseconds.value = base;
    milliseconds.value = withTiming(base + RUN_MS, {
      duration: RUN_MS,
      easing: Easing.linear,
      reduceMotion: ReduceMotion.Never,
    });
    return () => cancelAnimation(milliseconds);
  }, [running, milliseconds, run]);
  return milliseconds;
}
