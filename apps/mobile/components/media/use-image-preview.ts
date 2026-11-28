import { useEffect, useState } from "react";
import type { MobileArtifactTarget } from "../../lib/artifacts/artifact-open";
import { imageArtifactPreview } from "../../lib/artifacts/artifact-open";
import type { ImageSize } from "../../lib/messages/inline-image";

type SettledPreview =
  | { status: "ready"; uri: string; size: ImageSize }
  | { status: "error"; error: unknown };

const loading = { status: "loading" } as const;

export function useImagePreview(
  threadTarget: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
) {
  const ownerKind = "botId" in threadTarget ? "bot" : "group";
  const ownerId = "botId" in threadTarget ? threadTarget.botId : threadTarget.groupId;
  const key = JSON.stringify([ownerKind, ownerId, artifactId, mimeType]);
  const [result, setResult] = useState<{ key: string; preview: SettledPreview }>();

  useEffect(() => {
    let cancelled = false;
    const target: MobileArtifactTarget =
      ownerKind === "bot" ? { botId: ownerId } : { groupId: ownerId };
    void imageArtifactPreview(target, artifactId, mimeType)
      .then(({ uri, size }) => {
        if (!cancelled) setResult({ key, preview: { status: "ready", uri, size } });
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ key, preview: { status: "error", error } });
      });
    return () => {
      cancelled = true;
    };
  }, [key, ownerKind, ownerId, artifactId, mimeType]);

  return {
    preview: result?.key === key ? result.preview : loading,
    recordError: (error: unknown) => setResult({ key, preview: { status: "error", error } }),
  };
}
