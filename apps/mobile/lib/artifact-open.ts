import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { rpc } from "./api";
import { artifactCacheFileName, artifactShareFileName } from "./artifact-file";
import { t } from "./i18n";
import { createKeyedPromiseCache } from "./inline-image";

export type MobileArtifactTarget = { botId: string } | { groupId: string };

/** Writes an artifact's bytes to its cache file; no network call. */
export function writeArtifactCacheFile(
  artifactId: string,
  mimeType: string,
  contentBase64: string,
): File {
  const file = new File(Paths.cache, artifactCacheFileName(artifactId, mimeType));
  file.create({ overwrite: true });
  file.write(contentBase64, { encoding: "base64" });
  return file;
}

async function cacheMobileArtifact(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<File> {
  const artifact = await rpc<{ contentBase64: string }>("artifacts/get", {
    ...target,
    artifactId,
  });
  return writeArtifactCacheFile(artifactId, mimeType, artifact.contentBase64);
}

export async function readMobileArtifactText(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<string> {
  const file = await cacheMobileArtifact(target, artifactId, mimeType);
  return file.text();
}

export async function openMobileArtifact(
  target: MobileArtifactTarget,
  artifactId: string,
  name: string,
  mimeType: string,
): Promise<void> {
  const file = await cacheMobileArtifact(target, artifactId, mimeType);
  await shareNamedFile(file, mimeType, name);
}

const imageArtifactUris = createKeyedPromiseCache<string>(async (key) => {
  const request = imageArtifactRequests.get(key);
  if (!request) throw new Error("unknown image artifact");
  const file = await cacheMobileArtifact(request.target, request.artifactId, request.mimeType);
  return file.uri;
});
const imageArtifactRequests = new Map<
  string,
  { target: MobileArtifactTarget; artifactId: string; mimeType: string }
>();

/**
 * Local file URI of an image artifact, downloaded through the authenticated RPC and cached on
 * disk. Concurrent callers (every bubble showing the same image) share one download.
 */
export async function imageArtifactUri(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<string> {
  const scope = "botId" in target ? `bot:${target.botId}` : `group:${target.groupId}`;
  const key = `${scope}:${artifactId}`;
  imageArtifactRequests.set(key, { target, artifactId, mimeType });
  const entry = imageArtifactUris.get(key);
  const uri = await entry;
  // The OS may purge the cache directory between visits; a remembered URI is only as good
  // as the file behind it, so download again when it is gone. Forgetting by entry keeps the
  // retry single-flight when several bubbles notice the missing file at once.
  if (new File(uri).exists) return uri;
  imageArtifactUris.forget(key, entry);
  return imageArtifactUris.get(key);
}

/** Share a file already on disk (for example an image the viewer is showing) without downloading it again. */
export async function shareLocalFile(uri: string, mimeType: string, name: string): Promise<void> {
  await shareNamedFile(new File(uri), mimeType, name);
}

async function shareNamedFile(source: File, mimeType: string, name: string): Promise<void> {
  const root = new Directory(Paths.cache, "artifact-shares");
  if (!root.exists) root.create();
  const dir = new Directory(root, source.name || "attachment");
  if (!dir.exists) dir.create();
  const shared = new File(dir, artifactShareFileName(name, mimeType));
  source.copySync(shared, { overwrite: true });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(shared.uri, { mimeType });
    return;
  }
  throw new Error(t("Saved {name} locally", { name }));
}
