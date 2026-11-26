/** Only an opaque iOS header displaces the thread in the keyboard-avoiding view. */
export function threadKeyboardVerticalOffset({
  os,
  floatingHeader,
  nativeHeaderHeight,
}: {
  os: string;
  floatingHeader: boolean;
  nativeHeaderHeight: number;
}): number {
  return os === "ios" && !floatingHeader ? nativeHeaderHeight : 0;
}
