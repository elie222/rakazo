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

export function AttachmentFile({
  attachment,
  target,
  color,
  secondaryColor,
  pressableProps,
  onPreviewFile,
}: {
  attachment: FileBlock;
  target: MobileArtifactTarget;
  color: string;
  secondaryColor: string;
  pressableProps?: Omit<ComponentProps<typeof Pressable>, "onPress" | "children">;
  onPreviewFile: (artifactId: string) => void;
}) {
  const { i18n, t } = useLingui();
  const { artifactId, mimeType, name = t`File` } = attachment;
  const size = formatFileSize(attachment.size, i18n.locale);
  const open = () => {
    if (!artifactId) return;
    if (artifactPreviewKind(mimeType ?? "") !== "none") {
      onPreviewFile(artifactId);
      return;
    }
    void openMobileArtifact(target, artifactId, name, mimeType ?? "text/plain").catch((error) =>
      Alert.alert(t`Could not open file`, errorText(error, t`Try again.`)),
    );
  };
  return (
    <Pressable {...pressableProps} onPress={open}>
      <Text style={{ color, fontSize: 15 }}>📎 {name}</Text>
      {size ? (
        <Text style={{ color: secondaryColor, marginTop: 4, fontSize: 13 }}>{size}</Text>
      ) : null}
    </Pressable>
  );
}
