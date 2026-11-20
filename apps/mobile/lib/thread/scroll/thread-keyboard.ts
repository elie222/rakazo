import { useEffect, useRef, useState } from "react";
import {
  KeyboardController,
  KeyboardEvents,
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
 * composer and stops avoiding until the keyboard next shows.
 */
export function useThreadKeyboard() {
  const progress = useSharedValue(KeyboardController.isVisible() ? 1 : 0);
  const [avoiding, setAvoiding] = useState(true);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);

  useKeyboardHandler(
    {
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

  useEffect(() => {
    const subscription = KeyboardEvents.addListener("keyboardWillShow", () => setAvoiding(true));
    return () => {
      subscription.remove();
      clearTimeout(settle.current);
    };
  }, []);

  const onFocusChange = (focused: boolean) => {
    clearTimeout(settle.current);
    if (focused) return;
    settle.current = setTimeout(() => {
      if (progress.value === 0) return;
      progress.value = 0;
      setAvoiding(false);
    }, KEYBOARD_SETTLE_MS);
  };

  const { input } = useReanimatedFocusedInput();
  useAnimatedReaction(
    () => input.value !== null,
    (focused, previous) => {
      if (focused !== previous) scheduleOnRN(onFocusChange, focused);
    },
  );

  return { progress, avoiding };
}
