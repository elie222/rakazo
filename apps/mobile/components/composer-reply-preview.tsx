import type { ReplyPreview } from "@rakazo/contracts";
import { replyLabel } from "@rakazo/core";
import { Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import type { MobileArtifactTarget } from "../lib/artifact-open";
import { t } from "../lib/i18n";
import { ReplyThumbnail } from "./reply-thumbnail";

export function ComposerReplyPreview({
  author,
  quote,
  text,
  attachment,
  threadTarget,
}: {
  author: string;
  quote?: string | null;
  text: string;
  attachment?: ReplyPreview["attachment"];
  threadTarget?: MobileArtifactTarget;
}) {
  const tokens = mobileTokens();
  return (
    <>
      <ReplyThumbnail attachment={attachment} threadTarget={threadTarget} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>{author}</Text>
        <Text style={{ color: tokens.foreground, fontSize: 13 }} numberOfLines={1}>
          {replyLabel(quote, text, attachment, { photo: t("Photo"), attachment: t("Attachment") })}
        </Text>
      </View>
    </>
  );
}
