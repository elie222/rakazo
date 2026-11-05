import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { ArtifactVersion, ArtifactWithContent } from "@rakazo/contracts";
import { artifactPreviewKind } from "@rakazo/contracts";
import type { File } from "expo-file-system";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { NativeSymbol } from "../components/native-symbol";
import { PdfPreview } from "../components/pdf-preview";
import { SandboxedHtmlPreview } from "../components/sandboxed-html-preview";
import { VideoPreview } from "../components/video-preview";
import { formatActivityRelativeTime } from "../lib/activity";
import { mobileTokens } from "../lib/appearance";
import { shareLocalFile, writeArtifactCacheFile } from "../lib/artifact-open";
import {
  artifactThreadTarget,
  getArtifactById,
  listArtifactVersions,
  removeArtifact,
} from "../lib/artifacts";
import { useFloatingHeaderInset } from "../lib/floating-header";
import { t, useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

type PreviewContent =
  | { kind: "html"; html: string }
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string }
  | { kind: "pdf"; uri: string }
  | { kind: "image"; uri: string }
  | { kind: "video"; uri: string }
  | { kind: "unsupported" };

type ContentState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; artifact: ArtifactWithContent; file: File; preview: PreviewContent };

/** Past this a plain-text view gets slow to lay out; share the file to read the rest. */
const TEXT_PREVIEW_LIMIT = 100_000;

async function computePreview(mimeType: string, file: File): Promise<PreviewContent> {
  switch (artifactPreviewKind(mimeType)) {
    case "html":
      return { kind: "html", html: await file.text() };
    case "markdown":
      return { kind: "markdown", text: await file.text() };
    case "text": {
      const text = await file.text();
      return {
        kind: "text",
        text: text.length > TEXT_PREVIEW_LIMIT ? `${text.slice(0, TEXT_PREVIEW_LIMIT)}\n…` : text,
      };
    }
    case "pdf":
      return { kind: "pdf", uri: file.uri };
    case "image":
      return { kind: "image", uri: file.uri };
    case "video":
      return { kind: "video", uri: file.uri };
    case "none":
      return { kind: "unsupported" };
  }
}

export default function ArtifactDetailScreen() {
  const { artifactId, exact } = useLocalSearchParams<{ artifactId: string; exact?: string }>();
  const navigation = useNavigation();
  const router = useRouter();
  const headerInset = useFloatingHeaderInset();
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const styles = useThemedStyles(createStyles);

  const [versions, setVersions] = useState<ArtifactVersion[] | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [content, setContent] = useState<ContentState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setVersions(null);
    setSelectedVersionId(null);
    void listArtifactVersions(artifactId)
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
        // A chat attachment opens its own version; the Files list opens the newest.
        const attached = exact === "1" && list.some((version) => version.id === artifactId);
        setSelectedVersionId(attached ? artifactId : (list[0]?.id ?? artifactId));
      })
      .catch(() => {
        if (!cancelled) setSelectedVersionId(artifactId);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, exact]);

  useEffect(() => {
    if (!selectedVersionId) return;
    let cancelled = false;
    setContent({ status: "loading" });
    void getArtifactById(selectedVersionId)
      .then(async (artifact) => {
        const file = writeArtifactCacheFile(artifact.id, artifact.mimeType, artifact.contentBase64);
        const preview = await computePreview(artifact.mimeType, file);
        if (cancelled) return;
        setContent({ status: "ready", artifact, file, preview });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setContent({
            status: "error",
            message: errorText(error, t("Could not load this artifact.")),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedVersionId, t]);

  const confirmDelete = useCallback(() => {
    if (content.status !== "ready") return;
    const name = content.artifact.name;
    const versionCount = versions?.length ?? 1;
    Alert.alert(
      t('Delete "{name}"?', { name }),
      versionCount > 1
        ? t("This deletes all {count} versions of this artifact. This can't be undone.", {
            count: versionCount,
          })
        : t("This can't be undone."),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Delete"),
          style: "destructive",
          onPress: () =>
            void removeArtifact(artifactId)
              .then(() => router.back())
              .catch((error: unknown) =>
                Alert.alert(t("Could not delete this artifact"), errorText(error, t("Try again."))),
              ),
        },
      ],
    );
  }, [artifactId, content, router, t, versions]);

  // The full-screen viewer fetches through the thread the artifact belongs to.
  const imageTarget = content.status === "ready" ? artifactThreadTarget(content.artifact) : null;
  const openImage =
    content.status === "ready" && imageTarget
      ? () =>
          router.push({
            pathname: "/image",
            params: {
              artifactId: content.artifact.id,
              name: content.artifact.name,
              mimeType: content.artifact.mimeType,
              ...imageTarget,
            },
          })
      : null;

  function pickVersion() {
    if (!versions || versions.length < 2) return;
    presentMessageActionSheet({
      title: t("Versions"),
      selected: versions.findIndex((version) => version.id === selectedVersionId),
      cancel: t("Cancel"),
      more: t("More"),
      colorScheme,
      actions: versions.map((version) => ({
        text: `v${version.version} (${formatActivityRelativeTime(version.createdAt)})`,
        onPress: () => setSelectedVersionId(version.id),
      })),
    });
  }

  const share = useCallback(async () => {
    if (content.status !== "ready") return;
    try {
      await shareLocalFile(content.file.uri, content.artifact.mimeType, content.artifact.name);
    } catch (error) {
      Alert.alert(t("Could not share this artifact"), errorText(error, t("Try again.")));
    }
  }, [content, t]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: content.status === "ready" ? content.artifact.name : "",
      headerRight: () =>
        content.status === "ready" ? (
          <View style={styles.headerActions}>
            <Pressable
              accessibilityLabel={t("Share")}
              hitSlop={8}
              onPress={() => void share()}
              style={styles.headerButton}
            >
              <NativeSymbol ios="square.and.arrow.up" android="share-social-outline" size={19} />
            </Pressable>
            <Pressable
              accessibilityLabel={t("Delete")}
              hitSlop={8}
              onPress={confirmDelete}
              style={styles.headerButton}
            >
              <NativeSymbol
                ios="trash"
                android="trash-outline"
                size={19}
                color={mobileTokens().destructive}
              />
            </Pressable>
          </View>
        ) : null,
      ...(iosAtLeast(26)
        ? {
            unstable_headerRightItems: () =>
              content.status === "ready"
                ? [
                    {
                      type: "button" as const,
                      label: t("Share"),
                      icon: { type: "sfSymbol" as const, name: "square.and.arrow.up" },
                      onPress: () => void share(),
                    },
                    {
                      type: "button" as const,
                      label: t("Delete"),
                      icon: { type: "sfSymbol" as const, name: "trash" },
                      tintColor: mobileTokens().destructive,
                      onPress: confirmDelete,
                    },
                  ]
                : [],
          }
        : {}),
    });
  }, [confirmDelete, content, navigation, share, styles, t]);

  const scrolling =
    content.status === "ready" &&
    (content.preview.kind === "markdown" || content.preview.kind === "text");
  const versionPicker =
    content.status === "ready" && versions && versions.length > 1 ? (
      <View style={styles.pillRow}>
        <Pressable accessibilityRole="button" onPress={pickVersion} style={styles.pill}>
          <Text style={styles.pillText}>
            {`v${content.artifact.version} (${formatActivityRelativeTime(content.artifact.createdAt)})`}
          </Text>
          <NativeSymbol
            ios="chevron.down"
            android="chevron-down"
            size={12}
            color={native.secondaryLabel}
          />
        </Pressable>
      </View>
    ) : null;

  return (
    <View style={[styles.screen, { paddingTop: scrolling ? 0 : headerInset }]}>
      {scrolling ? null : versionPicker}
      <View style={styles.body}>
        {content.status === "loading" ? (
          <View style={styles.centered}>
            <ActivityIndicator color={native.secondaryLabel} />
          </View>
        ) : content.status === "error" ? (
          <View style={styles.centered}>
            <Text style={styles.errorText}>{content.message}</Text>
          </View>
        ) : (
          <ArtifactPreview
            preview={content.preview}
            scrollHeader={scrolling ? versionPicker : undefined}
            name={content.artifact.name}
            onOpenImage={openImage}
          />
        )}
      </View>
    </View>
  );
}

function ArtifactPreview({
  preview,
  scrollHeader,
  name,
  onOpenImage,
}: {
  preview: PreviewContent;
  scrollHeader?: ReactNode;
  name: string;
  onOpenImage: (() => void) | null;
}) {
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const tokens = mobileTokens();
  const colorScheme = useResolvedAppearance();
  if (preview.kind === "html") {
    return (
      <View style={styles.previewCard}>
        <SandboxedHtmlPreview html={preview.html} />
      </View>
    );
  }
  if (preview.kind === "markdown") {
    return (
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.markdownScroll}
        contentInsetAdjustmentBehavior="automatic"
      >
        {scrollHeader}
        <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
          {preview.text}
        </ChatMarkdown>
      </ScrollView>
    );
  }
  if (preview.kind === "text") {
    return (
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.markdownScroll}
        contentInsetAdjustmentBehavior="automatic"
      >
        {scrollHeader}
        <Text selectable style={styles.plainText}>
          {preview.text}
        </Text>
      </ScrollView>
    );
  }
  if (preview.kind === "pdf") {
    return (
      <View style={styles.previewCard}>
        <PdfPreview uri={preview.uri} name={name} />
      </View>
    );
  }
  if (preview.kind === "video") {
    return (
      <View style={styles.previewCard}>
        <VideoPreview uri={preview.uri} name={name} />
      </View>
    );
  }
  if (preview.kind === "image") {
    return (
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={name}
        disabled={!onOpenImage}
        onPress={onOpenImage ?? undefined}
        style={styles.imageWrap}
      >
        <Image source={{ uri: preview.uri }} style={styles.image} resizeMode="contain" />
      </Pressable>
    );
  }
  return (
    <View style={styles.centered}>
      <Text style={styles.errorText}>{t("No preview for this file type.")}</Text>
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 4 },
    headerButton: { padding: 8 },
    pillRow: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
    pill: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 999,
      backgroundColor: native.fill,
    },
    pillText: { color: native.label, fontSize: 13, fontWeight: "600" },
    body: { flex: 1, margin: 16, marginTop: 8, borderRadius: 18, overflow: "hidden" },
    centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
    errorText: { color: native.secondaryLabel, fontSize: 14, textAlign: "center" },
    previewCard: { flex: 1, borderRadius: 18, overflow: "hidden" },
    markdownScroll: { padding: 20 },
    plainText: {
      color: native.label,
      fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
      fontSize: 13,
      lineHeight: 19,
    },
    imageWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: native.fill,
    },
    image: { width: "100%", height: "100%" },
  });
}
