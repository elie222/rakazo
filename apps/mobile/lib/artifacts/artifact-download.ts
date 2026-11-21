import { artifactPreviewKind } from "@rakazo/contracts";
import { requireOptionalNativeModule } from "expo";
import { File } from "expo-file-system";
import { namedArtifactFile, shareLocalFile } from "./artifact-open";

// The root of expo-media-library talks to the Next module. Older binaries that receive this
// bundle over the air have neither the JS package nor the native module, so only import it
// when the build actually has it.
const mediaLibraryAvailable = Boolean(requireOptionalNativeModule("ExpoMediaLibraryNext"));

class PhotoLibraryPermissionError extends Error {}

async function saveToPhotoLibrary(uri: string, mimeType: string, name: string): Promise<void> {
  const { Asset, getPermissionsAsync, requestPermissionsAsync } = await import(
    "expo-media-library"
  );
  const permissions = ["photo", "video"] as const;
  const current = await getPermissionsAsync(true, [...permissions]);
  const granted =
    current.granted ||
    (current.canAskAgain && (await requestPermissionsAsync(true, [...permissions])).granted);
  if (!granted) throw new PhotoLibraryPermissionError("Photo library access was not granted");
  await Asset.create(namedArtifactFile(new File(uri), mimeType, name).uri);
}

/** Where the artifact went: the photo library, or the system share/save sheet. */
export type ArtifactDownloadResult = "saved" | "shared";

/**
 * Save an artifact to the device. Images and videos go to the photo library when the native
 * module is present; anything else (and any failure) uses the system share/save sheet, which is
 * the platform's general destination for arbitrary files.
 */
export async function downloadArtifactToDevice(
  uri: string,
  mimeType: string,
  name: string,
): Promise<ArtifactDownloadResult> {
  const kind = artifactPreviewKind(mimeType);
  if (mediaLibraryAvailable && (kind === "image" || kind === "video")) {
    try {
      await saveToPhotoLibrary(uri, mimeType, name);
      return "saved";
    } catch (error) {
      if (!(error instanceof PhotoLibraryPermissionError)) {
        console.warn("Could not save artifact to the photo library", error);
      }
      // A denied permission or an unsupported file still gets the system save sheet.
    }
  }
  await shareLocalFile(uri, mimeType, name);
  return "shared";
}
