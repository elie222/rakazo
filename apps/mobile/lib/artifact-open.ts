import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { rpc } from "./api";
import { artifactCacheFileName } from "./artifact-file";

async function cacheMobileArtifact(
  botId: string,
  artifactId: string,
  mimeType: string,
): Promise<File> {
  const artifact = await rpc<{ contentBase64: string }>("artifacts/get", { botId, artifactId });
  const file = new File(Paths.cache, artifactCacheFileName(artifactId, mimeType));
  file.create({ overwrite: true });
  file.write(artifact.contentBase64, { encoding: "base64" });
  return file;
}

export async function readMobileArtifactText(
  botId: string,
  artifactId: string,
  mimeType: string,
): Promise<string> {
  const file = await cacheMobileArtifact(botId, artifactId, mimeType);
  return file.text();
}

export async function openMobileArtifact(
  botId: string,
  artifactId: string,
  name: string,
  mimeType: string,
): Promise<void> {
  const file = await cacheMobileArtifact(botId, artifactId, mimeType);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, { mimeType });
    return;
  }
  throw new Error(`Saved ${name} locally`);
}
