import type { AppIcon } from "@rakazo/contracts";
import { DEFAULT_APP_ICON, isAppIcon } from "@rakazo/contracts";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { ImageSourcePropType } from "react-native";

type NativeAppIcon = {
  supported(): Promise<boolean>;
  /** Null while the app shows its primary icon. */
  current(): Promise<string | null>;
  set(name: string | null): Promise<void>;
};

/** iOS only: Android launchers need one manifest alias per icon and restart the app to switch. */
const native = () => requireOptionalNativeModule<NativeAppIcon>("RakazoAppIcon");

/** Matches the icon sets `plugins/with-alternate-app-icons.js` adds to the build. */
const ICON_SET_PREFIX = "AppIcon-";

export const APP_ICON_IMAGES: Record<AppIcon, ImageSourcePropType> = {
  default: require("../../assets/app-icons/default.png"),
  sunglasses: require("../../assets/app-icons/sunglasses.png"),
  headphones: require("../../assets/app-icons/headphones.png"),
  beanie: require("../../assets/app-icons/beanie.png"),
  cap: require("../../assets/app-icons/cap.png"),
  tie: require("../../assets/app-icons/tie.png"),
  "bow-tie": require("../../assets/app-icons/bow-tie.png"),
  scarf: require("../../assets/app-icons/scarf.png"),
  flower: require("../../assets/app-icons/flower.png"),
  sprout: require("../../assets/app-icons/sprout.png"),
  feet: require("../../assets/app-icons/feet.png"),
};

export async function appIconSupported(): Promise<boolean> {
  return (await native()?.supported()) === true;
}

export async function currentAppIcon(): Promise<AppIcon> {
  const name = await native()?.current();
  const icon = name?.startsWith(ICON_SET_PREFIX) ? name.slice(ICON_SET_PREFIX.length) : null;
  return isAppIcon(icon) ? icon : DEFAULT_APP_ICON;
}

export async function setAppIcon(icon: AppIcon): Promise<void> {
  const module = native();
  if (!module) throw new Error("This device cannot change the app icon.");
  await module.set(icon === DEFAULT_APP_ICON ? null : `${ICON_SET_PREFIX}${icon}`);
}

/** A device read, not an account one: each phone keeps its own icon. */
export const appIconRead = {
  queryKey: ["device", "app-icon"] as const,
  queryFn: async () => ({ supported: await appIconSupported(), icon: await currentAppIcon() }),
};
