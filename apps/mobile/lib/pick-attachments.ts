import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { inferAttachmentMimeType } from "@rakazo/core";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import {
  filterPickedAttachments,
  type PickedAttachment,
  type PickSkip,
} from "./pick-attachments-filter.js";

export type { PickedAttachment, PickSkip } from "./pick-attachments-filter.js";

async function readUriAsBase64(uri: string): Promise<{ contentBase64: string; size: number }> {
  const file = new File(uri);
  const knownSize = file.info().size;
  if (typeof knownSize === "number" && knownSize > ATTACHMENT_MAX_BYTES) {
    return { contentBase64: "", size: knownSize };
  }
  const contentBase64 = await file.base64();
  const size = knownSize ?? Math.floor((contentBase64.length * 3) / 4);
  return { contentBase64, size };
}

export async function pickFromLibrary(existingCount = 0): Promise<{
  attachments: PickedAttachment[];
  skipped: PickSkip[];
}> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    quality: 1,
  });
  if (result.canceled) return { attachments: [], skipped: [] };
  const candidates = await Promise.all(
    result.assets.map(async (asset) => {
      const name = asset.fileName ?? `photo-${asset.assetId ?? Date.now()}.jpg`;
      const mimeType = inferAttachmentMimeType(name, asset.mimeType ?? undefined);
      const { contentBase64, size } = await readUriAsBase64(asset.uri);
      return { name, mimeType, size, contentBase64, previewUri: asset.uri };
    }),
  );
  return filterPickedAttachments(existingCount, candidates);
}

export async function takePhoto(existingCount = 0): Promise<{
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
  const name = asset.fileName ?? `photo-${Date.now()}.jpg`;
  const mimeType = inferAttachmentMimeType(name, asset.mimeType ?? undefined);
  const { contentBase64, size } = await readUriAsBase64(asset.uri);
  return filterPickedAttachments(existingCount, [
    { name, mimeType, size, contentBase64, previewUri: asset.uri },
  ]);
}

export async function pickDocuments(existingCount = 0): Promise<{
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
      const { contentBase64, size } = await readUriAsBase64(asset.uri);
      return { name, mimeType, size, contentBase64 };
    }),
  );
  return filterPickedAttachments(existingCount, candidates);
}
