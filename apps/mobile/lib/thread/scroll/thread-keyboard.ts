import { useTimeout } from "@rakazo/chat-ui/hooks";
import { useState } from "react";
import {
  KeyboardController,
  useKeyboardHandler,
  useReanimatedFocusedInput,
} from "react-native-keyboard-controller";
import { useAnimatedReaction, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

/** Longer than the keyboard's hide animation. */
export const KEYBOARD_SETTLE_MS = 600;

/**
 * The keyboard's progress for the thread, frame by frame, and whether the screen should avoid it.
 * The keyboard library can miss a hide, which left the composer floating mid-screen over empty
 * space. With nothing focused for longer than a hide takes, the keyboard is down: this lowers the
 * composer and stops avoiding until the keyboard next shows. Android can report a show only through
 * transition frames, without a will-show event, so any opening transition resumes avoiding.
 */
export function useThreadKeyboard() {
  const progress = useSharedValue(KeyboardController.isVisible() ? 1 : 0);
  const [avoiding, setAvoiding] = useState(true);
  const [focused, setFocused] = useState(false);

  useKeyboardHandler(
    {
      onStart: (event) => {
        "worklet";
        if (event.progress > 0) scheduleOnRN(setAvoiding, true);
      },
      onMove: (event) => {
        "worklet";
        progress.value = event.progress;
      },
      onInteractive: (event) => {
        "worklet";
        progress.value = event.progress;
      },
      onEnd: (event) => {
        "worklet";
        progress.value = event.progress;
      },
    },
    [],
  );

  useTimeout(
    () => {
      if (progress.value === 0) return;
      progress.value = 0;
      setAvoiding(false);
    },
    focused ? null : KEYBOARD_SETTLE_MS,
  );

  const { input } = useReanimatedFocusedInput();
  useAnimatedReaction(
    () => input.value !== null,
    (current, previous) => {
      if (current !== previous) scheduleOnRN(setFocused, current);
    },
  );

  return { progress, avoiding };
}
