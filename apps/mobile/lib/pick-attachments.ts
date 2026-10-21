import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import { inferAttachmentMimeType } from "@rakazo/core";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import type * as ImageManipulatorModule from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { PickedAttachment, PickSkip } from "./pick-attachments-filter.js";
import { filterPickedAttachments } from "./pick-attachments-filter.js";

export type { PickedAttachment, PickSkip } from "./pick-attachments-filter.js";

/** A phone photo does not need its native resolution to be useful in chat. */
const MAX_IMAGE_EDGE = 1_600;
const IMAGE_COMPRESSION = 0.7;

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

function compressedImageName(name: string, format: ImageManipulatorModule.SaveFormat): string {
  const extension = format === "png" ? ".png" : ".jpg";
  return `${name.replace(/\.[^./\\]+$/, "") || "photo"}${extension}`;
}

async function prepareImage(
  uri: string,
  name: string,
  sourceMimeType: string | null | undefined,
  width: number | undefined,
  height: number | undefined,
) {
  const mimeType = inferAttachmentMimeType(name, sourceMimeType ?? undefined);
  // Preserve animation and transparency in GIF and WebP images.
  if (mimeType === "image/gif" || mimeType === "image/webp") return { uri, name, mimeType };
  if (!width || !height || Math.max(width, height) <= MAX_IMAGE_EDGE) {
    return { uri, name, mimeType };
  }
  const manipulator = loadImageManipulator();
  if (!manipulator) return { uri, name, mimeType };
  const format =
    mimeType === "image/png" ? manipulator.SaveFormat.PNG : manipulator.SaveFormat.JPEG;
  try {
    const context = manipulator.ImageManipulator.manipulate(uri);
    context.resize(width >= height ? { width: MAX_IMAGE_EDGE } : { height: MAX_IMAGE_EDGE });
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ compress: IMAGE_COMPRESSION, format });
    return {
      uri: saved.uri,
      name: compressedImageName(name, format),
      mimeType: format === "png" ? "image/png" : "image/jpeg",
    };
  } catch {
    // An unreadable or unsupported image should not block the whole picker.
    return { uri, name, mimeType };
  }
}

async function readUriAsBase64(
  uri: string,
  maxBytes: number,
): Promise<{ contentBase64: string; size: number }> {
  const file = new File(uri);
  const knownSize = file.info().size;
  if (typeof knownSize === "number" && knownSize > maxBytes) {
    return { contentBase64: "", size: knownSize };
  }
  const contentBase64 = await file.base64();
  const size = knownSize ?? Math.floor((contentBase64.length * 3) / 4);
  return { contentBase64, size };
}

export async function pickFromLibrary(
  existingCount = 0,
  maxBytes = ATTACHMENT_MAX_BYTES,
): Promise<{
  attachments: PickedAttachment[];
  skipped: PickSkip[];
}> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    quality: 1,
  });
  if (result.canceled) return { attachments: [], skipped: [] };
  const attachments: PickedAttachment[] = [];
  const skipped: PickSkip[] = [];
  for (const asset of result.assets) {
    const originalName = asset.fileName ?? `photo-${asset.assetId ?? Date.now()}.jpg`;
    // Once full, let the filter report the skip without processing the file.
    let candidate: Parameters<typeof filterPickedAttachments>[1][number] = {
      name: originalName,
      mimeType: inferAttachmentMimeType(originalName, asset.mimeType ?? undefined),
      size: 0,
      contentBase64: "",
      previewUri: asset.uri,
    };
    if (existingCount + attachments.length < ATTACHMENT_MAX_COUNT) {
      const prepared = await prepareImage(
        asset.uri,
        originalName,
        asset.mimeType,
        asset.width,
        asset.height,
      );
      const { contentBase64, size } = await readUriAsBase64(prepared.uri, maxBytes);
      candidate = {
        name: prepared.name,
        mimeType: prepared.mimeType,
        size,
        contentBase64,
        previewUri: prepared.uri,
      };
    }
    const filtered = filterPickedAttachments(
      existingCount + attachments.length,
      [candidate],
      maxBytes,
    );
    attachments.push(...filtered.attachments);
    skipped.push(...filtered.skipped);
  }
  return { attachments, skipped };
}

export async function takePhoto(
  existingCount = 0,
  maxBytes = ATTACHMENT_MAX_BYTES,
): Promise<{
  attachments: PickedAttachment[];
  skipped: PickSkip[];
}> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    return { attachments: [], skipped: [{ name: "camera", reason: "permission denied" }] };
  }
  const result = await ImagePicker.launchCameraAsync({ quality: 1 });
  if (result.canceled) return { attachments: [], skipped: [] };
  const asset = result.assets[0];
  if (!asset) return { attachments: [], skipped: [] };
  const originalName = asset.fileName ?? `photo-${Date.now()}.jpg`;
  const prepared = await prepareImage(
    asset.uri,
    originalName,
    asset.mimeType,
    asset.width,
    asset.height,
  );
  const { contentBase64, size } = await readUriAsBase64(prepared.uri, maxBytes);
  return filterPickedAttachments(
    existingCount,
    [
      {
        name: prepared.name,
        mimeType: prepared.mimeType,
        size,
        contentBase64,
        previewUri: prepared.uri,
      },
    ],
    maxBytes,
  );
}

export async function pickDocuments(
  existingCount = 0,
  maxBytes = ATTACHMENT_MAX_BYTES,
): Promise<{
  attachments: PickedAttachment[];
  skipped: PickSkip[];
}> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return { attachments: [], skipped: [] };
  const assets = result.assets ?? [];
  const candidates = await Promise.all(
    assets.map(async (asset) => {
      const name = asset.name ?? "file";
      const mimeType = inferAttachmentMimeType(name, asset.mimeType ?? undefined);
      const { contentBase64, size } = await readUriAsBase64(asset.uri, maxBytes);
      return { name, mimeType, size, contentBase64 };
    }),
  );
  return filterPickedAttachments(existingCount, candidates, maxBytes);
}
