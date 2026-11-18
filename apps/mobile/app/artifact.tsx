import { ph, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { ArtifactVersion, ArtifactWithContent } from "@rakazo/contracts";
import { artifactPreviewKind } from "@rakazo/contracts";
import type { File } from "expo-file-system";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { ArtifactMediaPager } from "../components/media/artifact-media-pager";
import { PdfPreview } from "../components/media/pdf-preview";
import { SandboxedHtmlPreview } from "../components/media/sandboxed-html-preview";
import { VideoPreview } from "../components/media/video-preview";
import { NativeSymbol } from "../components/native/native-symbol";
import { errorText } from "../lib/api/user-error";
import { mobileTokens } from "../lib/appearance/appearance";
import { downloadArtifactToDevice } from "../lib/artifacts/artifact-download";
import { isMediaArtifact, parseArtifactGallery } from "../lib/artifacts/artifact-gallery";
import { shareLocalFile, writeArtifactCacheFile } from "../lib/artifacts/artifact-open";
import {
  artifactThreadTarget,
  getArtifactById,
  listArtifactVersions,
  removeArtifact,
} from "../lib/artifacts/artifacts";
import { formatActivityRelativeTime } from "../lib/inbox/activity";
import { useFloatingHeaderInset } from "../lib/layout/floating-header";
import { useSideInsets } from "../lib/layout/side-insets";
import { presentMessageActionSheet } from "../lib/messages/message-action-sheet";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native/native";
import { iosAtLeast } from "../lib/native/native-controls";

type PreviewContent =
  | { kind: "html"; html: string }
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string }
  | { kind: "pdf"; uri: string }
  | { kind: "image"; uri: string }
  | { kind: "video"; uri: string }
  | { kind: "unsupported" };

type LoadedArtifact = Omit<ArtifactWithContent, "contentBase64">;

type ReadyContent = {
  status: "ready";
  artifact: LoadedArtifact;
  file: File;
  preview: PreviewContent;
};

type ContentState = { status: "loading" } | { status: "error"; message: string } | ReadyContent;

type LoadedPage = {
  versions: ArtifactVersion[];
  selectedVersionId: string;
  content: ReadyContent;
};

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

function withoutContent(artifact: ArtifactWithContent): LoadedArtifact {
  const { contentBase64: _contentBase64, ...loaded } = artifact;
  return loaded;
}

async function loadContent(versionId: string): Promise<ReadyContent> {
  const artifact = await getArtifactById(versionId);
  const file = writeArtifactCacheFile(artifact.id, artifact.mimeType, artifact.contentBase64);
  const preview = await computePreview(artifact.mimeType, file);
  return { status: "ready", artifact: withoutContent(artifact), file, preview };
}

async function loadPage(familyId: string, exactVersionId: string | null): Promise<LoadedPage> {
  let versions: ArtifactVersion[] = [];
  try {
    versions = await listArtifactVersions(familyId);
  } catch {
    // The version list is optional; the content may still be fetched by the family id.
  }
  // A chat attachment opens its own version; the Files list opens the newest.
  const attached = exactVersionId && versions.some((version) => version.id === exactVersionId);
  const selectedVersionId = (attached ? exactVersionId : null) ?? versions[0]?.id ?? familyId;
  return { versions, selectedVersionId, content: await loadContent(selectedVersionId) };
}

export default function ArtifactDetailScreen() {
  const {
    artifactId,
    exact,
    gallery: galleryParam,
  } = useLocalSearchParams<{
    artifactId: string;
    exact?: string;
    gallery?: string | string[];
  }>();
  const navigation = useNavigation();
  const router = useRouter();
  const deletionContext = useRef<object | null>(null);
  const pages = useRef(new Map<string, LoadedPage>());
  const downloading = useRef(false);
  const gallery = useMemo(() => parseArtifactGallery(galleryParam), [galleryParam]);
  // Only a list page with more than one media artifact can swipe; deep links and chat stay single.
  const pagerGallery = useMemo(
    () => (gallery.length > 1 && gallery.some((item) => item.id === artifactId) ? gallery : null),
    [artifactId, gallery],
  );
  const [activeId, setActiveId] = useState(artifactId);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  useFocusEffect(
    useCallback(() => {
      deletionContext.current = {};
      return () => {
        deletionContext.current = null;
      };
    }, [activeId]),
  );
  const headerInset = useFloatingHeaderInset();
  const { t } = useLingui();
  const colorScheme = useResolvedAppearance();
  const styles = useThemedStyles(createStyles);

  const [versions, setVersions] = useState<ArtifactVersion[] | null>(null);
  const versionsRef = useRef<ArtifactVersion[] | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const selectedVersionRef = useRef<string | null>(null);
  const [content, setContent] = useState<ContentState>({ status: "loading" });

  const applyPage = useCallback((page: LoadedPage) => {
    versionsRef.current = page.versions;
    setVersions(page.versions);
    selectedVersionRef.current = page.selectedVersionId;
    setSelectedVersionId(page.selectedVersionId);
    setContent(page.content);
  }, []);

  useEffect(() => {
    activeIdRef.current = artifactId;
    setActiveId(artifactId);
    versionsRef.current = null;
    selectedVersionRef.current = null;
    setVersions(null);
    setSelectedVersionId(null);
    setContent({ status: "loading" });
  }, [artifactId]);

  useEffect(() => {
    let cancelled = false;
    const exactVersionId = exact === "1" && activeId === artifactId ? artifactId : null;
    const cached = pages.current.get(activeId);
    if (cached && (!exactVersionId || cached.selectedVersionId === exactVersionId)) {
      applyPage(cached);
      return;
    }
    versionsRef.current = null;
    setVersions(null);
    setSelectedVersionId(null);
    setContent({ status: "loading" });
    void loadPage(activeId, exactVersionId).then(
      (page) => {
        pages.current.set(activeId, page);
        if (!cancelled) applyPage(page);
      },
      (error: unknown) => {
        if (!cancelled) {
          setContent({
            status: "error",
            message: errorText(error, t`Could not load this artifact.`),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activeId, applyPage, artifactId, exact, t]);

  const changeActive = useCallback((id: string) => {
    if (id === activeIdRef.current) return;
    activeIdRef.current = id;
    setActiveId(id);
    versionsRef.current = null;
    selectedVersionRef.current = null;
    setVersions(null);
    setSelectedVersionId(null);
    setContent({ status: "loading" });
  }, []);

  const selectVersion = useCallback(
    (versionId: string) => {
      const familyId = activeIdRef.current;
      const pageVersions = versionsRef.current ?? [];
      selectedVersionRef.current = versionId;
      setSelectedVersionId(versionId);
      setContent({ status: "loading" });
      void loadContent(versionId).then(
        (loaded) => {
          if (activeIdRef.current !== familyId || selectedVersionRef.current !== versionId) return;
          pages.current.set(familyId, {
            versions: pageVersions,
            selectedVersionId: versionId,
            content: loaded,
          });
          setContent(loaded);
        },
        (error: unknown) => {
          if (activeIdRef.current === familyId && selectedVersionRef.current === versionId) {
            setContent({
              status: "error",
              message: errorText(error, t`Could not load this artifact.`),
            });
          }
        },
      );
    },
    [t],
  );

  const confirmDelete = useCallback(() => {
    if (content.status !== "ready") return;
    const context = deletionContext.current;
    if (!context) return;
    const isCurrent = () => deletionContext.current === context;
    const name = content.artifact.name;
    const versionCount = versions?.length ?? 1;
    Alert.alert(
      t`Delete "${name}"?`,
      versionCount > 1
        ? t`This deletes all ${ph({ count: versionCount })} versions of this artifact. This can't be undone.`
        : t`This can't be undone.`,
      [
        { text: t`Cancel`, style: "cancel" },
        {
          text: t`Delete`,
          style: "destructive",
          onPress: () => {
            if (!isCurrent()) return;
            void removeArtifact(activeId)
              .then(() => {
                if (isCurrent()) router.back();
              })
              .catch((error: unknown) => {
                if (isCurrent()) {
                  Alert.alert(t`Could not delete this artifact`, errorText(error, t`Try again.`));
                }
              });
          },
        },
      ],
    );
  }, [activeId, content, router, t, versions]);

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
      title: t`Versions`,
      selected: versions.findIndex((version) => version.id === selectedVersionId),
      cancel: t`Cancel`,
      more: t`More`,
      colorScheme,
      actions: versions.map((version) => ({
        text: `v${version.version} (${formatActivityRelativeTime(version.createdAt)})`,
        onPress: () => selectVersion(version.id),
      })),
    });
  }

  const share = useCallback(async () => {
    if (content.status !== "ready") return;
    try {
      await shareLocalFile(content.file.uri, content.artifact.mimeType, content.artifact.name);
    } catch (error) {
      Alert.alert(t`Could not share this artifact`, errorText(error, t`Try again.`));
    }
  }, [content, t]);

  const download = useCallback(async () => {
    if (content.status !== "ready" || downloading.current) return;
    downloading.current = true;
    try {
      const result = await downloadArtifactToDevice(
        content.file.uri,
        content.artifact.mimeType,
        content.artifact.name,
      );
      if (result === "saved") Alert.alert(t`Saved to Photos`);
    } catch (error) {
      Alert.alert(t`Could not download this artifact`, errorText(error, t`Try again.`));
    } finally {
      downloading.current = false;
    }
  }, [content, t]);

  const downloadable = content.status === "ready" && isMediaArtifact(content.artifact);
  const activeGalleryItem = pagerGallery?.find((item) => item.id === activeId) ?? null;
  const title =
    content.status === "ready" ? content.artifact.name : (activeGalleryItem?.name ?? "");

  useLayoutEffect(() => {
    navigation.setOptions({
      title,
      headerRight: () =>
        content.status === "ready" ? (
          <View style={styles.headerActions}>
            {downloadable ? (
              <Pressable
                accessibilityLabel={t`Download`}
                hitSlop={8}
                onPress={() => void download()}
                style={styles.headerButton}
              >
                <NativeSymbol ios="arrow.down.circle" android="download-outline" size={19} />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel={t`Share`}
              hitSlop={8}
              onPress={() => void share()}
              style={styles.headerButton}
            >
              <NativeSymbol ios="square.and.arrow.up" android="share-social-outline" size={19} />
            </Pressable>
            <Pressable
              accessibilityLabel={t`Delete`}
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
                    ...(downloadable
                      ? [
                          {
                            type: "button" as const,
                            label: t`Download`,
                            icon: { type: "sfSymbol" as const, name: "arrow.down.circle" },
                            onPress: () => void download(),
                          },
                        ]
                      : []),
                    {
                      type: "button" as const,
                      label: t`Share`,
                      icon: { type: "sfSymbol" as const, name: "square.and.arrow.up" },
                      onPress: () => void share(),
                    },
                    {
                      type: "button" as const,
                      label: t`Delete`,
                      icon: { type: "sfSymbol" as const, name: "trash" },
                      tintColor: mobileTokens().destructive,
                      onPress: confirmDelete,
                    },
                  ]
                : [],
          }
        : {}),
    });
  }, [confirmDelete, content, downloadable, download, navigation, share, styles, t, title]);

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

  const activePreview =
    content.status === "loading" ? (
      <View style={styles.centered}>
        <ActivityIndicator color={native.secondaryLabel} />
      </View>
    ) : content.status === "error" ? (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{content.message}</Text>
      </View>
    ) : (
      <ArtifactPreview
        key={content.artifact.id}
        preview={content.preview}
        scrollHeader={scrolling ? versionPicker : undefined}
        name={content.artifact.name}
        onOpenImage={openImage}
      />
    );

  return (
    <View style={[styles.screen, { paddingTop: scrolling ? 0 : headerInset }]}>
      {scrolling ? null : versionPicker}
      <View style={styles.body}>
        {pagerGallery ? (
          <ArtifactMediaPager
            gallery={pagerGallery}
            activeId={activeId}
            onActiveIdChange={changeActive}
            renderPage={(_item, active) =>
              active ? activePreview : <View style={styles.pagePlaceholder} />
            }
          />
        ) : (
          activePreview
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
      <Text style={styles.errorText}>{t`No preview for this file type.`}</Text>
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
    pagePlaceholder: { flex: 1, backgroundColor: native.fill },
  });
}
