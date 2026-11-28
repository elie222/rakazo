import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { artifactPreviewKind } from "@rakazo/contracts";
import { formatFileSize } from "@rakazo/core";
import type { ComponentProps } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { withAlpha } from "../../lib/appearance/ripple";
import type { MobileArtifactTarget } from "../../lib/artifacts/artifact-open";
import { openMobileArtifact } from "../../lib/artifacts/artifact-open";
import { NativeSymbol } from "../native/native-symbol";

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
    <Pressable {...pressableProps} onPress={open} style={styles.row}>
      <View style={{ ...styles.tile, backgroundColor: withAlpha(secondaryColor, 0.14) }}>
        <NativeSymbol ios="doc.text" android="document-text-outline" size={18} color={color} />
      </View>
      <View style={styles.body}>
        {/* The whole name wraps, so files with long, similar names stay tellable apart. */}
        <Text style={{ ...styles.name, color }}>{name}</Text>
        {size ? <Text style={{ ...styles.size, color: secondaryColor }}>{size}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  tile: {
    width: 36,
    height: 36,
    borderRadius: 9,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flexShrink: 1, gap: 2 },
  name: { fontSize: 15 },
  size: { fontSize: 13 },
});
