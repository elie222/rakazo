import { BOT_AVATAR_VALUE_MAX_LENGTH, isBotAvatarValue } from "@rakazo/contracts";
import { File } from "expo-file-system";
import type * as ImageManipulatorModule from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { requireOptionalNativeModule } from "expo-modules-core";

/** Profile photos reuse the bot-avatar value: a 256x256 webp data URL, capped at 200k chars. */
export const USER_AVATAR_EDGE = 256;

export type PickUserAvatarResult =
  | { status: "picked"; image: string }
  | { status: "canceled" }
  | { status: "error"; reason: "unavailable" | "unreadable" | "too-large" };

let imageManipulator: typeof ImageManipulatorModule | null | undefined;

function loadImageManipulator() {
  if (imageManipulator !== undefined) return imageManipulator;
  imageManipulator = null;
  try {
    if (requireOptionalNativeModule("ExpoImageManipulator")) {
      imageManipulator = require("expo-image-manipulator") as typeof ImageManipulatorModule;
    }
  } catch {
    // Older binaries may not be able to load the package.
  }
  return imageManipulator;
}

/** A data URL the server will store, or null when it would exceed the value cap. */
export function toUserAvatarDataUrl(base64: string): string | null {
  const value = `data:image/webp;base64,${base64}`;
  return isBotAvatarValue(value) ? value : null;
}

/** True for a stored profile photo value (a data-URL image within the cap). */
export function isUserAvatarImage(value: string | null | undefined): value is string {
  if (!value || value.length > BOT_AVATAR_VALUE_MAX_LENGTH) return false;
  return isBotAvatarValue(value) && value.startsWith("data:image/");
}

async function readBase64(uri: string): Promise<string> {
  return new File(uri).base64();
}

async function toAvatarImage(
  uri: string,
  width: number | undefined,
  height: number | undefined,
  mimeType: string | null | undefined,
): Promise<string | null> {
  const manipulator = loadImageManipulator();
  if (!manipulator || !width || !height) {
    // Without the resizer, keep the original file when it already fits the cap.
    const base64 = await readBase64(uri);
    const type = mimeType === "image/png" ? "png" : mimeType === "image/gif" ? "gif" : "jpeg";
    const value = `data:image/${type};base64,${base64}`;
    return isBotAvatarValue(value) ? value : null;
  }
  // Center-crop to a square, then shrink to the avatar edge: every photo becomes
  // the same 256x256 webp, like the bot avatars. A failure here is unreadable, not
  // too large, so it propagates to the caller.
  const side = Math.min(width, height);
  for (const compress of [0.8, 0.5]) {
    const context = manipulator.ImageManipulator.manipulate(uri);
    context.crop({
      originX: Math.floor((width - side) / 2),
      originY: Math.floor((height - side) / 2),
      width: side,
      height: side,
    });
    context.resize({ width: USER_AVATAR_EDGE, height: USER_AVATAR_EDGE });
    const image = await context.renderAsync();
    const saved = await image.saveAsync({
      compress,
      format: manipulator.SaveFormat.WEBP,
    });
    const value = toUserAvatarDataUrl(await readBase64(saved.uri));
    if (value) return value;
  }
  return null;
}

/** Opens the system photo picker and returns a 256x256 webp data URL, or why not. */
export async function pickUserAvatarImage(): Promise<PickUserAvatarResult> {
  let result: ImagePicker.ImagePickerResult;
  try {
    result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: false,
      quality: 1,
    });
  } catch {
    return { status: "error", reason: "unavailable" };
  }
  if (result.canceled) return { status: "canceled" };
  const asset = result.assets[0];
  if (!asset) return { status: "canceled" };
  try {
    const image = await toAvatarImage(asset.uri, asset.width, asset.height, asset.mimeType);
    if (!image) return { status: "error", reason: "too-large" };
    return { status: "picked", image };
  } catch {
    return { status: "error", reason: "unreadable" };
  }
}
