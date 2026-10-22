import * as ScreenOrientation from "expo-screen-orientation";
import { Dimensions, Platform } from "react-native";
import { isCompactScreen } from "./adaptive-layout";

// Wider compact windows stay unlocked so a foldable can rotate after unfolding on iOS.
const PHONE_ASPECT_RATIO_LIMIT = 0.6;

let rotationHolds = 0;
let applied: Promise<unknown> = Promise.resolve();

/**
 * Narrow phone-sized screens stay portrait. Wider windows and tablets rotate freely, and so
 * does any screen while a full-screen viewer holds rotation.
 */
export function appOrientationLock(
  screen: { width: number; height: number },
  rotationHeld: boolean,
): ScreenOrientation.OrientationLock {
  const aspectRatio = Math.min(screen.width, screen.height) / Math.max(screen.width, screen.height);
  return rotationHeld || !isCompactScreen(screen) || aspectRatio >= PHONE_ASPECT_RATIO_LIMIT
    ? ScreenOrientation.OrientationLock.DEFAULT
    : ScreenOrientation.OrientationLock.PORTRAIT_UP;
}

/**
 * Applies the lock the current screen and holds call for. Calls run one after another and
 * each reads the state when it runs, so a slow earlier call cannot undo a newer one.
 */
export function syncOrientation(): Promise<unknown> {
  applied = applied.then(() =>
    ScreenOrientation.lockAsync(
      appOrientationLock(
        Dimensions.get(Platform.OS === "ios" ? "window" : "screen"),
        rotationHolds > 0,
      ),
    ).catch(() => undefined),
  );
  return applied;
}

/** Lets the screen rotate until the returned release runs; holds from overlapping screens stack. */
export function holdFreeRotation(): () => void {
  rotationHolds += 1;
  void syncOrientation();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rotationHolds -= 1;
    void syncOrientation();
  };
}
