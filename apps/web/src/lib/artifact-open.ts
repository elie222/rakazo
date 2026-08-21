import { isAttachmentImageMimeType } from "@rakazo/contracts";
import { rpc } from "./rpc";

export function decodeArtifactBase64(contentBase64: string): Uint8Array {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function openArtifact(
  botId: string,
  artifactId: string,
  name: string,
  mimeType: string,
): Promise<void> {
  const artifact = await rpc.artifacts.get({ botId, artifactId });
  const bytes = decodeArtifactBase64(artifact.contentBase64);
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  if (isAttachmentImageMimeType(mimeType)) {
    window.open(url, "_blank", "noopener,noreferrer");
  } else {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
