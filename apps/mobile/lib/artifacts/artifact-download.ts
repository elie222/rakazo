import { bestEffort } from "@rakazo/logging/best-effort";
import { requireOptionalNativeModule } from "expo";
import { File } from "expo-file-system";
import { Platform } from "react-native";
import { isMediaArtifact } from "./artifact-gallery";
import { namedArtifactFile, shareLocalFile } from "./artifact-open";

// An over-the-air bundle can run on a binary built before the native module was added.
const mediaLibraryAvailable = Boolean(requireOptionalNativeModule("ExpoMediaLibraryNext"));

async function saveToPhotoLibrary(uri: string, mimeType: string, name: string): Promise<boolean> {
  const { Asset, getPermissionsAsync, requestPermissionsAsync } = await import(
    "expo-media-library"
  );
  // Expo uses MediaStore on Android 11 and later. Writing a new file needs no read or storage grant.
  if (!(Platform.OS === "android" && Number(Platform.Version) >= 30)) {
    const current = await getPermissionsAsync(true);
    if (
      !current.granted &&
      !(current.canAskAgain && (await requestPermissionsAsync(true)).granted)
    ) {
      return false;
    }
  }
  const file = namedArtifactFile(new File(uri), mimeType, name);
  await Asset.create(file.uri);
  return true;
}

/** Saves media to Photos when available, otherwise opens the system share sheet. */
export async function downloadArtifactToDevice(
  uri: string,
  mimeType: string,
  name: string,
): Promise<"saved" | "shared"> {
  if (mediaLibraryAvailable && isMediaArtifact({ mimeType })) {
    const saved = await bestEffort(
      "Save artifact to photo library",
      saveToPhotoLibrary(uri, mimeType, name),
    );
    if (saved) return "saved";
  }
  await shareLocalFile(uri, mimeType, name);
  return "shared";
}
