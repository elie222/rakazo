import type { ReplyPreview } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import type { MobileArtifactTarget } from "../lib/artifact-open";
import { imageArtifactUri } from "../lib/artifact-open";

export function ReplyThumbnail({
  attachment,
  threadTarget,
}: {
  attachment?: ReplyPreview["attachment"];
  threadTarget?: MobileArtifactTarget;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const botId = threadTarget && "botId" in threadTarget ? threadTarget.botId : undefined;
  const groupId = threadTarget && "groupId" in threadTarget ? threadTarget.groupId : undefined;
  const artifactId = attachment?.kind === "image" ? attachment.artifactId : undefined;
  const mimeType = attachment?.mimeType;
  useEffect(() => {
    let cancelled = false;
    setUri(null);
    setFailed(false);
    if (!artifactId || !mimeType || (!botId && !groupId)) return;
    void imageArtifactUri(botId ? { botId } : { groupId: groupId! }, artifactId, mimeType)
      .then((uri) => {
        if (!cancelled) setUri(uri);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, mimeType, botId, groupId]);
  if (!artifactId || !threadTarget || failed) return null;
  const style = { width: 32, height: 32, borderRadius: 6, backgroundColor: mobileTokens().muted };
  return uri ? (
    <Image
      source={{ uri }}
      style={style}
      resizeMode="cover"
      accessible={false}
      accessibilityIgnoresInvertColors
      onError={() => setFailed(true)}
    />
  ) : (
    <View style={style} accessible={false} />
  );
}
