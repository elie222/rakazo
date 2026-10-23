/**
 * Distance from the top of the screen to the chat's keyboard avoiding view.
 *
 * Android uses the measured window position. A floating iOS header starts the chat
 * at the top of the screen; an opaque header would need its native height.
 */
export function threadKeyboardOffset({
  os,
  floatingHeader,
  nativeHeaderHeight,
  measuredOffset,
}: {
  os: string;
  floatingHeader: boolean;
  nativeHeaderHeight: number;
  measuredOffset: number;
}) {
  if (os === "android") return measuredOffset;
  if (os === "ios" && !floatingHeader) return nativeHeaderHeight;
  return 0;
}
