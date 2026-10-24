import {
  ATTACHMENT_IMAGE_MAX_EDGE,
  ATTACHMENT_IMAGE_QUALITY,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
} from "@rakazo/contracts";
import { inferAttachmentMimeType } from "@rakazo/core";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import type * as ImageManipulatorModule from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { DroppedFile } from "./file-drop";
import { releaseDroppedFile } from "./file-drop";
import type { PickedAttachment, PickSkip } from "./pick-attachments-filter.js";
import {
  attachmentCountSkipReason,
  attachmentSizeSkipReason,
  attachmentSkipReason,
  filterPickedAttachments,
  pickedAttachment,
} from "./pick-attachments-filter.js";

export type { PickedAttachment, PickSkip } from "./pick-attachments-filter.js";

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
  if (!width || !height || Math.max(width, height) <= ATTACHMENT_IMAGE_MAX_EDGE) {
    return { uri, name, mimeType };
  }
  const manipulator = loadImageManipulator();
  if (!manipulator) return { uri, name, mimeType };
  const format =
    mimeType === "image/png" ? manipulator.SaveFormat.PNG : manipulator.SaveFormat.JPEG;
  try {
    const context = manipulator.ImageManipulator.manipulate(uri);
    context.resize(
      width >= height
        ? { width: ATTACHMENT_IMAGE_MAX_EDGE }
        : { height: ATTACHMENT_IMAGE_MAX_EDGE },
    );
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ compress: ATTACHMENT_IMAGE_QUALITY, format });
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

export async function readDroppedFiles(
  files: DroppedFile[],
  existingCount = 0,
  maxBytes = ATTACHMENT_MAX_BYTES,
  notCopied: readonly string[] = [],
): Promise<{
  attachments: PickedAttachment[];
  skipped: PickSkip[];
}> {
  const skipped: PickSkip[] = notCopied.map((name) => ({
    name,
    reason: attachmentCountSkipReason(),
  }));
  const attachments: PickedAttachment[] = [];
  try {
    for (const file of files) {
      const mimeType = inferAttachmentMimeType(file.name, file.mimeType || undefined);
      const reason = attachmentSkipReason(
        { name: file.name, size: file.size ?? 0, mimeType },
        existingCount,
        attachments.length,
        maxBytes,
      );
      if (reason) {
        skipped.push({ name: file.name, reason });
        continue;
      }
      if (!file.uri) continue;
      const read = await readUriAsBase64(file.uri, maxBytes).catch(() => null);
      if (!read) {
        // A copy that vanished or cannot be read costs that file only.
        skipped.push({ name: file.name, reason: "permission denied" });
        continue;
      }
      const { contentBase64, size } = read;
      if (size > maxBytes) {
        skipped.push({ name: file.name, reason: attachmentSizeSkipReason(maxBytes) });
        continue;
      }
      const previewUri = mimeType?.startsWith("image/")
        ? `data:${mimeType};base64,${contentBase64}`
        : undefined;
      attachments.push(
        pickedAttachment(
          { name: file.name, mimeType, size, contentBase64, previewUri },
          existingCount + attachments.length,
        ),
      );
    }
  } finally {
    await Promise.allSettled(
      files.flatMap((file) => (file.uri ? [releaseDroppedFile(file.uri)] : [])),
    );
  }
  return { attachments, skipped };
}

export async function readSharedFiles(
  files: Array<{ uri: string; name: string; mimeType: string | null }>,
  existingCount = 0,
  maxBytes = ATTACHMENT_MAX_BYTES,
) {
  // Loaded with the first share, so ordinary pickers never pull the share module.
  const { readIncomingShareFile } = await import("./incoming-share");
  const attachments: PickedAttachment[] = [];
  const skipped: PickSkip[] = [];
  const failedFiles: typeof files = [];
  for (const file of files) {
    if (existingCount + attachments.length >= ATTACHMENT_MAX_COUNT) {
      skipped.push({ name: file.name, reason: attachmentCountSkipReason() });
      continue;
    }
    try {
      const result = await readIncomingShareFile(file.uri, maxBytes, async (copy, name, type) => {
        const mimeType = inferAttachmentMimeType(name, type || file.mimeType || undefined);
        const { contentBase64, size } = await readUriAsBase64(copy.uri, maxBytes);
        // The cache copy is removed after this read; previews must own their bytes.
        const previewUri = mimeType?.startsWith("image/")
          ? `data:${mimeType};base64,${contentBase64}`
          : undefined;
        return filterPickedAttachments(
          existingCount + attachments.length,
          [{ name, mimeType, size, contentBase64, previewUri }],
          maxBytes,
        );
      });
      if (!result) {
        skipped.push({ name: file.name, reason: attachmentSizeSkipReason(maxBytes) });
        continue;
      }
      attachments.push(...result.attachments);
      skipped.push(...result.skipped);
    } catch {
      skipped.push({ name: file.name, reason: "could not read" });
      failedFiles.push(file);
    }
  }
  return { attachments, skipped, failedFiles };
}
