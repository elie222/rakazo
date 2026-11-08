import { parseBotAvatarValue } from "@rakazo/contracts";
import { DEFAULT_BOT_AVATAR_COLOR } from "@rakazo/core";

/** The color a bot avatar value is drawn in; a photo falls back to the default color. */
export function avatarColor(value: string): string {
  const parsed = parseBotAvatarValue(value);
  return parsed.kind === "color" || parsed.kind === "shape"
    ? parsed.color
    : DEFAULT_BOT_AVATAR_COLOR;
}

export function avatarShape(value: string): number | null {
  const parsed = parseBotAvatarValue(value);
  return parsed.kind === "shape" ? parsed.shapeIndex : null;
}

export function isAvatarPhoto(value: string): boolean {
  return parseBotAvatarValue(value).kind === "image";
}

/** Keeps a chosen shape when the color changes; a photo is replaced by the color. */
export function withAvatarColor(value: string, color: string): string {
  const shape = avatarShape(value);
  return shape === null ? color : `${color}::shape_${shape}`;
}

export function withAvatarShape(value: string, shape: number): string {
  return `${avatarColor(value)}::shape_${shape}`;
}
