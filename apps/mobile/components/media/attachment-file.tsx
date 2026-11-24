import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { artifactPreviewKind } from "@rakazo/contracts";
import { formatFileSize } from "@rakazo/core";
import type { ComponentProps } from "react";
import { Alert, Pressable, Text } from "react-native";
import { errorText } from "../../lib/api/user-error";
import type { MobileArtifactTarget } from "../../lib/artifacts/artifact-open";
import { openMobileArtifact } from "../../lib/artifacts/artifact-open";

type FileBlock = Extract<MessageBlock, { kind: "file" }>;

/** A file the message carries: its name, its size, and the viewer or share sheet it opens. */
export function AttachmentFile({
  attachment,
  target,
  locale,
  color,
  secondaryColor,
  pressableProps,
  onPreviewFile,
}: {
  attachment: FileBlock;
  target: MobileArtifactTarget;
  locale: string;
  color: string;
  secondaryColor: string;
  pressableProps?: Omit<ComponentProps<typeof Pressable>, "onPress" | "children">;
  onPreviewFile: (artifactId: string) => void;
}) {
  const { t } = useLingui();
  const size = formatFileSize(attachment.size, locale);
  return (
    <Pressable
      {...pressableProps}
      onPress={() =>
        attachment.artifactId
          ? artifactPreviewKind(attachment.mimeType ?? "") !== "none"
            ? onPreviewFile(attachment.artifactId)
            : void openMobileArtifact(
                target,
                attachment.artifactId,
                attachment.name ?? t`File`,
                attachment.mimeType ?? "text/plain",
              ).catch((err) => Alert.alert(t`Could not open file`, errorText(err, t`Try again.`)))
          : undefined
      }
    >
      <Text style={{ color, fontSize: 15 }}>📎 {attachment.name ?? t`File`}</Text>
      {size ? (
        <Text style={{ color: secondaryColor, marginTop: 4, fontSize: 13 }}>{size}</Text>
      ) : null}
    </Pressable>
  );
}
