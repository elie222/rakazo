import { ph, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { ArtifactWithContent } from "@rakazo/contracts";
import { artifactPreviewKind } from "@rakazo/contracts";
import { errorCode, errorStatus } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import type { File } from "expo-file-system";
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
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
import { useSpaceChanges } from "../lib/api/roster-signals";
import { errorText } from "../lib/api/user-error";
import { mobileTokens } from "../lib/appearance/appearance";
import { artifactContentRead } from "../lib/artifacts/artifact-detail-read";
import { downloadArtifactToDevice } from "../lib/artifacts/artifact-download";
import { isMediaArtifact, parseArtifactGallery } from "../lib/artifacts/artifact-gallery";
import { shareLocalFile, writeArtifactCacheFile } from "../lib/artifacts/artifact-open";
import { artifactThreadTarget } from "../lib/artifacts/artifacts";
import { formatActivityRelativeTime } from "../lib/inbox/activity";
import { useFloatingHeaderInset } from "../lib/layout/floating-header";
import { useSideInsets } from "../lib/layout/side-insets";
import { presentMessageActionSheet } from "../lib/messages/message-action-sheet";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native/native";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

type PreviewContent =
  | { kind: "html"; html: string }
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string }
  | { kind: "pdf"; uri: string }
  | { kind: "image"; uri: string }
  | { kind: "video"; uri: string }
  | { kind: "unsupported" };

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

async function prepareContent(
  { contentBase64, ...artifact }: ArtifactWithContent,
  scope: string[],
) {
  const file = writeArtifactCacheFile(artifact.id, artifact.mimeType, contentBase64, scope);
  return { artifact, file, preview: await computePreview(artifact.mimeType, file) };
}

function artifactUnavailable(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 401 || status === 403 || errorCode(error) === "NOT_FOUND";
}

export default function ArtifactDetailScreen() {
  const { artifactId, exact, gallery } = useLocalSearchParams<{
    artifactId: string;
    exact?: string;
    gallery?: string | string[];
  }>();
  return (
    <ArtifactDetail
      key={JSON.stringify([artifactId, exact, gallery])}
      artifactId={artifactId}
      exact={exact === "1"}
      galleryParam={gallery}
    />
  );
}

function ArtifactDetail({
  artifactId,
  exact,
  galleryParam,
}: {
  artifactId: string;
  exact: boolean;
  galleryParam?: string | string[];
}) {
  const router = useRouter();
  const focused = useIsFocused();
  const headerInset = useFloatingHeaderInset();
  const { t } = useLingui();
  const colorScheme = useResolvedAppearance();
  const styles = useThemedStyles(createStyles);
  const familyContext = useRef<object | null>(null);
  const versionContext = useRef<object | null>(null);
  const downloading = useRef(new Set<string>());

  const gallery = useMemo(() => parseArtifactGallery(galleryParam), [galleryParam]);
  const pagerGallery =
    !exact && gallery.length > 1 && gallery.some((item) => item.id === artifactId) ? gallery : null;
  const [activeId, setActiveId] = useState(artifactId);
  const [pickedVersionId, setPickedVersionId] = useState<string>();

  const versionsRead = rpcQuery("artifacts/listVersions", { familyId: activeId });
  const versionsQuery = useScreenQuery({
    ...versionsRead,
    gcTime: 0,
    queryFn: (request) => {
      const result = Promise.resolve(versionsRead.queryFn(request));
      void bestEffort("Read artifact versions", result);
      return result;
    },
  });
  const historyUnavailable = artifactUnavailable(versionsQuery.error);
  const versions = versionsQuery.data;
  const requestedVersionId = pickedVersionId ?? (exact ? artifactId : undefined);
  const selectedVersionId =
    versions?.find((version) => version.id === requestedVersionId)?.id ??
    versions?.[0]?.id ??
    activeId;
  const contentRead = artifactContentRead(selectedVersionId);
  const cacheScope = contentRead.queryKey.slice(0, 3).map(String);
  const contentQuery = useScreenQuery(
    {
      queryKey: [...contentRead.queryKey, "preview"],
      queryFn: async (request) => {
        const artifact = await contentRead.queryFn(request);
        if (request.signal.aborted) throw request.signal.reason;
        return prepareContent(artifact, cacheScope);
      },
      gcTime: 0,
    },
    { enabled: !versionsQuery.isPending && !historyUnavailable, onFocus: false },
  );
  const loadError = historyUnavailable ? versionsQuery.error : contentQuery.error;
  const unavailable = artifactUnavailable(loadError);
  const content = unavailable ? undefined : contentQuery.data;
  useSpaceChanges("artifacts", () => versionsQuery.refetch({ cancelRefetch: false }), focused);

  const familyScope = JSON.stringify(versionsRead.queryKey);
  const versionScope = JSON.stringify(contentRead.queryKey);
  useFocusEffect(
    useCallback(() => {
      familyContext.current = {};
      return () => {
        familyContext.current = null;
      };
    }, [familyScope]),
  );
  useFocusEffect(
    useCallback(() => {
      if (unavailable) return;
      versionContext.current = {};
      return () => {
        versionContext.current = null;
      };
    }, [activeId, unavailable, versionScope]),
  );

  const remove = useSave<{ id: string; isCurrent: () => boolean }>({
    save: ({ id }, send) => send("artifacts/remove", { artifactId: id }),
    onSaved: (_, { isCurrent }) => {
      if (isCurrent()) router.back();
    },
    onFailed: (error, { isCurrent }) => {
      if (isCurrent())
        Alert.alert(t`Could not delete this artifact`, errorText(error, t`Try again.`));
    },
  });

  const confirmDelete = (isCurrent: () => boolean) => {
    if (!content || !isCurrent()) return;
    const shownFamily = familyContext.current;
    if (!shownFamily) return;
    const stillShowingFamily = () => familyContext.current === shownFamily;
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
            if (isCurrent()) remove.run({ id: activeId, isCurrent: stillShowingFamily });
          },
        },
      ],
    );
  };

  // The full-screen viewer fetches through the thread the artifact belongs to.
  const imageTarget = content ? artifactThreadTarget(content.artifact) : null;
  const openImage =
    content && imageTarget
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
    const shown = versionContext.current;
    if (!shown || !versions || versions.length < 2) return;
    presentMessageActionSheet({
      title: t`Versions`,
      selected: versions.findIndex((version) => version.id === selectedVersionId),
      cancel: t`Cancel`,
      more: t`More`,
      colorScheme,
      actions: versions.map((version) => ({
        text: `v${version.version} (${formatActivityRelativeTime(version.createdAt)})`,
        onPress: () => {
          if (versionContext.current === shown) setPickedVersionId(version.id);
        },
      })),
    });
  }

  async function exportArtifact(save: boolean, isCurrent: () => boolean) {
    if (!content || !isCurrent()) return;
    const { mimeType, name } = content.artifact;
    if (downloading.current.has(versionScope)) return;
    downloading.current.add(versionScope);
    try {
      const file = content.file.exists
        ? content.file
        : (await contentQuery.refetch({ throwOnError: true, cancelRefetch: false })).data?.file;
      if (!file || !isCurrent()) return;
      if (save) {
        const result = await downloadArtifactToDevice(file.uri, mimeType, name);
        if (result === "saved" && isCurrent()) Alert.alert(t`Saved to Photos`);
      } else {
        await shareLocalFile(file.uri, mimeType, name);
      }
    } catch (error) {
      if (isCurrent()) {
        Alert.alert(
          save ? t`Could not download this artifact` : t`Could not share this artifact`,
          errorText(error, t`Try again.`),
        );
      }
    } finally {
      downloading.current.delete(versionScope);
    }
  }

  function showActions() {
    const shown = versionContext.current;
    if (!content || !shown) return;
    const isCurrent = () => versionContext.current === shown;
    presentMessageActionSheet({
      title: content.artifact.name,
      colorScheme,
      cancel: t`Cancel`,
      more: t`More`,
      actions: [
        ...(isMediaArtifact(content.artifact)
          ? [{ text: t`Download`, onPress: () => void exportArtifact(true, isCurrent) }]
          : []),
        { text: t`Share`, onPress: () => void exportArtifact(false, isCurrent) },
        { text: t`Delete`, onPress: () => confirmDelete(isCurrent) },
      ],
    });
  }

  useScreenHeader({
    title: content?.artifact.name ?? pagerGallery?.find((item) => item.id === activeId)?.name ?? "",
    action: content
      ? { label: t`More`, onPress: showActions, prominence: "secondary", busy: remove.pending }
      : null,
  });

  const scrolling = content?.preview.kind === "markdown" || content?.preview.kind === "text";
  const versionPicker =
    content && versions && versions.length > 1 ? (
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

  const activePreview = content ? (
    <ArtifactPreview
      key={content.artifact.id}
      preview={content.preview}
      scrollHeader={scrolling ? versionPicker : undefined}
      name={content.artifact.name}
      onOpenImage={openImage}
    />
  ) : (
    <View style={styles.centered}>
      {loadError ? (
        <Text style={styles.errorText}>
          {errorText(loadError, t`Could not load this artifact.`)}
        </Text>
      ) : (
        <ActivityIndicator color={native.secondaryLabel} />
      )}
    </View>
  );

  return (
    <View style={[styles.screen, { paddingTop: scrolling ? 0 : headerInset }]}>
      {scrolling ? null : versionPicker}
      <View style={styles.body}>
        {pagerGallery ? (
          <ArtifactMediaPager
            gallery={pagerGallery}
            activeId={activeId}
            onActiveIdChange={(id) => {
              setPickedVersionId(undefined);
              setActiveId(id);
            }}
          >
            {activePreview}
          </ArtifactMediaPager>
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
