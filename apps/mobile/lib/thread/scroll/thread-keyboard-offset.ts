/**
 * Whether the chat screen should pad itself for the keyboard.
 *
 * Android does not: the composer dock lifts itself by the keyboard's own height instead, because a
 * screen-level view works that distance out from where it sits in the window, and the measurement
 * is taken once, on the first layout, before the native header has settled. When it comes back
 * short by the header's height the composer lands behind the keyboard. Anchored to the window's
 * bottom edge, the dock only needs the keyboard height, so nothing has to be measured.
 *
 * iOS keeps the avoiding view: its floating header does not occupy vertical space in the chat
 * layout, so the measured offset is right there.
 */
export function threadKeyboardAvoidance({
  os,
  floatingHeader,
  nativeHeaderHeight,
}: {
  os: string;
  floatingHeader: boolean;
  nativeHeaderHeight: number;
}): { enabled: boolean; automaticOffset: boolean; keyboardVerticalOffset: number } {
  if (os === "android") {
    return { enabled: false, automaticOffset: false, keyboardVerticalOffset: 0 };
  }
  return {
    enabled: true,
    automaticOffset: false,
    keyboardVerticalOffset: os === "ios" && !floatingHeader ? nativeHeaderHeight : 0,
  };
}

/**
 * How tall the Android dock may be while it is lifted by the keyboard.
 *
 * Lifting moves the dock up without shrinking the space it is laid out in, so a dock with many
 * attachment rows could otherwise rise past the top of the thread and sit under the native header.
 * Capping it to the room left above the keyboard keeps expanded controls inside the thread, as the
 * old padding did. Written as a worklet because the dock applies it on the animation thread.
 */
export function keyboardDockMaxHeight(availableHeight: number, keyboardHeight: number): number {
  "worklet";
  return Math.max(0, availableHeight - keyboardHeight);
}

/**
 * Room the message list keeps clear at its newest end while the keyboard is up, so the last
 * message is not stranded behind it once the dock has lifted.
 */
export function keyboardListInset({
  os,
  rootOwnsKeyboard,
  keyboardHeight,
}: {
  os: string;
  rootOwnsKeyboard: boolean;
  keyboardHeight: number;
}): number {
  if (os !== "android" || rootOwnsKeyboard) return 0;
  return Math.max(0, keyboardHeight);
}
