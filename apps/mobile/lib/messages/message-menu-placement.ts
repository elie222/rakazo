/** Keep the measured menu inside the safe viewport, including very short windows. */
export function messageMenuPlacement({
  width,
  height,
  insets,
  anchor,
  measuredHeight,
  maxWidth,
}: {
  width: number;
  height: number;
  insets: { top: number; bottom: number; left: number; right: number };
  anchor: { x: number; y: number };
  measuredHeight: number;
  maxWidth: number;
}) {
  const edge = 12;
  const leftEdge = Math.min(width, insets.left + edge);
  const topEdge = Math.min(height, insets.top + edge);
  const menuWidth = Math.max(0, Math.min(maxWidth, width - leftEdge - insets.right - edge));
  const maxHeight = Math.max(0, height - topEdge - insets.bottom - edge);
  const menuHeight = Math.min(measuredHeight, maxHeight);
  const left = Math.max(
    leftEdge,
    Math.min(anchor.x - menuWidth / 2, width - insets.right - edge - menuWidth),
  );
  const top = Math.max(
    topEdge,
    Math.min(anchor.y - menuHeight / 3, height - insets.bottom - edge - menuHeight),
  );
  return { left, top, menuWidth, maxHeight };
}
