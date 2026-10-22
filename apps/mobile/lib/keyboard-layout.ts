import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LayoutChangeEvent, View } from "react-native";
import { AppState, Dimensions, Keyboard, Platform } from "react-native";
import { KeyboardEvents } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Frame = { y: number; height: number };

/** Re-measure screen coordinates when the keyboard is needed, including after resume. */
export function useKeyboardLayout() {
  const container = useRef<View>(null);
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  const safeArea = useSafeAreaInsets();
  const sequence = useRef(0);
  const mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const measure = useCallback(() => {
    if (Platform.OS !== "android") return;
    const ownSequence = ++sequence.current;
    const frame = new Promise<Frame | null>((resolve) => {
      const view = container.current;
      if (!view) return resolve(null);
      // An unavailable native view may never invoke its measurement callback.
      const deadline = setTimeout(() => resolve(null), 250);
      try {
        view.measureInWindow((_x, y, _width, height) => {
          clearTimeout(deadline);
          resolve({ y, height });
        });
      } catch {
        clearTimeout(deadline);
        resolve(null);
      }
    });
    void frame.then((frame) => {
      if (!mounted.current || ownSequence !== sequence.current) return;
      // The avoiding view starts at y=0 inside this wrapper. Its parent coordinate
      // origin is the wrapper's window y, including any parent-relative displacement.
      const nextOffset = frame && frame.height > 0 ? frame.y : offsetRef.current;
      if (frame && frame.height > 0 && Number.isFinite(nextOffset)) {
        offsetRef.current = nextOffset;
        setOffset(nextOffset);
      }
    });
  }, []);

  const schedule = useCallback(() => {
    if (Platform.OS !== "android") return;
    measure();
    if (timer.current) clearTimeout(timer.current);
    // Re-check after native animations and layout propagation have settled.
    timer.current = setTimeout(measure, 350);
  }, [measure]);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      mounted.current = true;
      schedule();
      // Keep the foreground position current even without a new layout event.
      const refresh = setInterval(() => {
        if (AppState.currentState === "active") measure();
      }, 5_000);
      const listeners = [
        Keyboard.addListener("keyboardWillShow", schedule),
        Keyboard.addListener("keyboardDidShow", schedule),
        Keyboard.addListener("keyboardDidHide", schedule),
        KeyboardEvents.addListener("keyboardDidShow", schedule),
        KeyboardEvents.addListener("keyboardDidHide", schedule),
        AppState.addEventListener("change", schedule),
        Dimensions.addEventListener("change", schedule),
      ];
      return () => {
        mounted.current = false;
        ++sequence.current;
        if (timer.current) clearTimeout(timer.current);
        clearInterval(refresh);
        for (const listener of listeners) listener.remove();
      };
    }, [measure, schedule]),
  );

  // Insets can change independently of the window dimensions.
  useEffect(schedule, [safeArea, schedule]);

  const onLayout = useCallback((_event: LayoutChangeEvent) => schedule(), [schedule]);
  return { container, offset, onLayout, onFocus: schedule };
}
