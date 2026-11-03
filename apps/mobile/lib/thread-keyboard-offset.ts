/**
 * `automaticOffset` reads the avoiding view's absolute window position from
 * native code on Android. Do not add a second measured offset to it: on a
 * tablet, split-screen or after a keyboard resize it double-counts the header.
 *
 * iOS retains its existing behavior because its floating header does not
 * occupy vertical space in the chat layout.
 */
export function threadKeyboardAvoidance({
  os,
  floatingHeader,
  nativeHeaderHeight,
}: {
  os: string;
  floatingHeader: boolean;
  nativeHeaderHeight: number;
}): { automaticOffset: boolean; keyboardVerticalOffset: number } {
  if (os === "android") return { automaticOffset: true, keyboardVerticalOffset: 0 };
  return {
    automaticOffset: false,
    keyboardVerticalOffset: os === "ios" && !floatingHeader ? nativeHeaderHeight : 0,
  };
}
