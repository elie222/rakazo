/** Distances are logical screen points; velocities are points per second. */
export function shouldDismissImage(translationY: number, velocityY: number): boolean {
  "worklet";
  return Math.abs(translationY) >= 120 || Math.abs(velocityY) >= 1000;
}

export function imageDismissBackdropOpacity(translationY: number): number {
  "worklet";
  return Math.max(0, 1 - Math.abs(translationY) / 300);
}
