import { BOT_AVATAR_VALUE_MAX_LENGTH, BOT_COLORS, parseBotAvatarValue } from "@rakazo/contracts";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

/** The color a bot avatar value is drawn in; a photo falls back to the first palette color. */
export function avatarColor(value: string): string {
  const parsed = parseBotAvatarValue(value);
  return parsed.kind === "color" || parsed.kind === "shape" ? parsed.color : BOT_COLORS[0];
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

const PHOTO_SIZE = 256;

/**
 * Lets the person pick and square-crop a photo, then stores it the way the desktop Avatar Studio
 * does: a 256px image data URL small enough for the avatar field.
 */
export async function pickAvatarPhoto(): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  const side = Math.min(asset.width, asset.height);
  const context = ImageManipulator.manipulate(asset.uri);
  if (side > 0 && asset.width !== asset.height) {
    context.crop({
      originX: (asset.width - side) / 2,
      originY: (asset.height - side) / 2,
      width: side,
      height: side,
    });
  }
  context.resize({ width: PHOTO_SIZE, height: PHOTO_SIZE });
  const image = await context.renderAsync();
  for (const compress of [0.9, 0.7, 0.5]) {
    const saved = await image.saveAsync({ format: SaveFormat.WEBP, compress, base64: true });
    const value = saved.base64 ? `data:image/webp;base64,${saved.base64}` : null;
    if (value && value.length <= BOT_AVATAR_VALUE_MAX_LENGTH) return value;
  }
  return null;
}
