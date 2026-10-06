import type { Artifact, ArtifactVersion } from "@rakazo/contracts";
import { rpc } from "./api";
import type { MobileArtifactTarget } from "./artifact-open";

export type MobileArtifactSummary = Artifact & { versionCount: number };
export type MobileArtifactWithContent = Artifact & { contentBase64: string };

export type ArtifactListPage = { items: MobileArtifactSummary[]; nextCursor: string | null };

export function listSpaceArtifacts(input: {
  botId?: string;
  cursor?: string;
  limit?: number;
}): Promise<ArtifactListPage> {
  return rpc<ArtifactListPage>("artifacts/listSpace", input);
}

export function listArtifactVersions(familyId: string): Promise<ArtifactVersion[]> {
  return rpc<ArtifactVersion[]>("artifacts/listVersions", { familyId });
}

export function getArtifactById(artifactId: string): Promise<MobileArtifactWithContent> {
  return rpc<MobileArtifactWithContent>("artifacts/getById", { artifactId });
}

export function removeArtifact(artifactId: string): Promise<{ ok: true }> {
  return rpc<{ ok: true }>("artifacts/remove", { artifactId });
}

/** Group scope wins: a bot-scoped read drops rows that also have a group id. */
export function artifactThreadTarget(
  artifact: Pick<Artifact, "botId" | "groupId">,
): MobileArtifactTarget | null {
  if (artifact.groupId) return { groupId: artifact.groupId };
  if (artifact.botId) return { botId: artifact.botId };
  return null;
}

/** Short badge text for a mime type ("HTML", "MD", "PDF", or its subtype). */
export function mimeBadgeLabel(mimeType: string): string {
  if (mimeType === "text/html") return "HTML";
  if (mimeType === "text/markdown") return "MD";
  if (mimeType === "application/pdf") return "PDF";
  const slash = mimeType.indexOf("/");
  return (slash === -1 ? mimeType : mimeType.slice(slash + 1)).toUpperCase().slice(0, 6);
}

/** Client-side search over an already-loaded page, matching the web Artifacts page. */
export function matchesArtifactQuery(
  item: Pick<Artifact, "name" | "description">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    item.name.toLowerCase().includes(needle) ||
    (item.description?.toLowerCase().includes(needle) ?? false)
  );
}
