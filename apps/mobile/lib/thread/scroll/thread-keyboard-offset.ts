/**
 * Android offsets by its opaque header, as an opaque iOS header does. `automaticOffset` reads the
 * avoiding view's window position from native code once, on its first layout. In a chat that
 * opens with history that read came back without the header (Android 14 and 15, edge to edge),
 * so the padding fell a header short and the keyboard covered the message box. The header height
 * is the gap between the window top and the avoiding view on a phone.
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
  if (os === "android")
    return { automaticOffset: false, keyboardVerticalOffset: nativeHeaderHeight };
  return {
    automaticOffset: false,
    keyboardVerticalOffset: os === "ios" && !floatingHeader ? nativeHeaderHeight : 0,
  };
}
