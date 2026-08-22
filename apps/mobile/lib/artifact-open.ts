import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { rpc } from "./api";
import { artifactCacheFileName } from "./artifact-file";

export async function openMobileArtifact(
  botId: string,
  artifactId: string,
  name: string,
  mimeType: string,
): Promise<void> {
  const artifact = await rpc<{ contentBase64: string }>("artifacts/get", { botId, artifactId });
  const file = new File(Paths.cache, artifactCacheFileName(artifactId, mimeType));
  file.create({ overwrite: true });
  file.write(artifact.contentBase64, { encoding: "base64" });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, { mimeType });
    return;
  }
  throw new Error(`Saved ${name} locally`);
}
