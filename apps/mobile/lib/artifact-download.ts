import { artifactPreviewKind } from "@rakazo/contracts";
import { requireOptionalNativeModule } from "expo";
import { File } from "expo-file-system";
import { namedArtifactFile, shareLocalFile } from "./artifact-open";

// The root of expo-media-library talks to the Next module. Older binaries that receive this
// bundle over the air have neither the JS package nor the native module, so only import it
// when the build actually has it.
const mediaLibraryAvailable = Boolean(requireOptionalNativeModule("ExpoMediaLibraryNext"));

async function saveToPhotoLibrary(uri: string, mimeType: string, name: string): Promise<void> {
  const { Asset, getPermissionsAsync, requestPermissionsAsync } = await import(
    "expo-media-library"
  );
  const permissions = ["photo", "video"] as const;
  const current = await getPermissionsAsync(true, [...permissions]);
  const granted =
    current.granted ||
    (current.canAskAgain && (await requestPermissionsAsync(true, [...permissions])).granted);
  if (!granted) throw new Error("Photo library access was not granted");
  await Asset.create(namedArtifactFile(new File(uri), mimeType, name).uri);
}

/**
 * Save an artifact to the device. Images and videos go to the photo library when the native
 * module is present; anything else (and any failure) uses the system share/save sheet, which is
 * the platform's general destination for arbitrary files.
 */
export async function downloadArtifactToDevice(
  uri: string,
  mimeType: string,
  name: string,
): Promise<void> {
  const kind = artifactPreviewKind(mimeType);
  if (mediaLibraryAvailable && (kind === "image" || kind === "video")) {
    try {
      await saveToPhotoLibrary(uri, mimeType, name);
      return;
    } catch {
      // An unsupported type or a denied permission still gets the system save sheet.
    }
  }
  await shareLocalFile(uri, mimeType, name);
}
