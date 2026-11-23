import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { PageSectionAnchor } from "@rakazo/contracts";
import type { PageReviewSections } from "@rakazo/core";
import { pageReviewContent, pageReviewSections } from "@rakazo/core";
import { queryOptions } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SandboxedHtmlPreview } from "../components/media/sandboxed-html-preview";
import { SettingsGroup, SettingsRow } from "../components/settings/settings-group";
import { currentApiBase } from "../lib/api/api";
import { errorText } from "../lib/api/user-error";
import { useMobileTokens, useResolvedAppearance } from "../lib/native/native";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { PageLoadFailure } from "../lib/pages/page-load-failure";
import { PageReviewComments } from "../lib/pages/page-review-comments";
import { usePageReviewSignals } from "../lib/pages/page-review-reads";
import { pageDocument, pageMessage } from "../lib/pages/pages";
import { targetRpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { ACCOUNT_SETTINGS } from "../lib/query/settings-target";

export default function PageReviewScreen() {
  const { pageId } = useLocalSearchParams<{ pageId: string }>();
  return <Review key={pageId} pageId={pageId} />;
}

function Review({ pageId }: { pageId: string }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const theme = useResolvedAppearance();
  const [revision, setRevision] = useState<{ version: number; anchor: PageSectionAnchor }>();
  const version = revision?.version;
  const [showComments, setShowComments] = useState(false);
  const [draftId, setDraftId] = useState<string>();
  const [anchors, setAnchors] = useState<PageReviewSections>();
  const read = targetRpcQuery(ACCOUNT_SETTINGS, "pageReviews/get", { pageId, version });
  const review = useScreenQuery(read);
  const page = review.isError ? undefined : review.data;
  const draft = useScreenQuery(
    targetRpcQuery(ACCOUNT_SETTINGS, "pageReviews/draft", { pageId, requestId: draftId ?? "" }),
    { enabled: Boolean(page?.owner && draftId) },
  );
  const { code: source, sections } = pageReviewContent({
    page,
    showingDraft: Boolean(draftId),
    draftCode: draft.isError ? undefined : draft.data?.code,
    reported: anchors,
  });
  const apiBase = currentApiBase();
  const runtimeError = t`This page couldn't be shown.`;
  const document = useScreenQuery(
    {
      queryKey: queryOptions<string>({
        queryKey: [
          ...read.queryKey,
          "document",
          apiBase,
          source,
          theme,
          !draftId,
          runtimeError,
          revision?.anchor,
        ],
      }).queryKey,
      gcTime: 0,
      queryFn: () =>
        pageDocument(apiBase, source!, theme, runtimeError, {
          review: !draftId,
          reviewAnchor: revision?.anchor.section,
          reviewAnchorOccurrence: revision?.anchor.sectionOccurrence,
        }),
    },
    { enabled: source !== undefined },
  );
  usePageReviewSignals();
  const publish = useSave({
    target: ACCOUNT_SETTINGS,
    save: (requestId: string, send) => send("pageReviews/publish", { pageId, requestId }),
    stale: [
      read.queryKey,
      targetRpcQuery(ACCOUNT_SETTINGS, "pageReviews/comments", { pageId }).queryKey,
    ],
    onSaved: () => {
      setDraftId(undefined);
      setRevision(undefined);
      setShowComments(true);
    },
  });
  const backToLatest = () => {
    setRevision(undefined);
    setShowComments(false);
  };
  const backToComments = () => {
    publish.reset();
    setDraftId(undefined);
    setShowComments(true);
  };
  useScreenHeader({
    title: draftId ? t`Draft revision` : showComments ? t`Comments` : page?.title,
    action: !page
      ? revision
        ? { label: t`Back to latest`, onPress: backToLatest, prominence: "secondary" }
        : null
      : draftId
        ? draft.isError
          ? {
              label: t`Back to comments`,
              onPress: backToComments,
              disabled: publish.pending,
            }
          : {
              label: t`Publish revision`,
              busy: publish.pending,
              disabled: !document.data,
              onPress: () => publish.run(draftId),
            }
        : {
            label: showComments ? t`View page` : t`Comments`,
            prominence: "secondary",
            onPress: () => setShowComments(!showComments),
          },
  });
  if (!page || (draftId && draft.isError)) {
    const error = review.error ?? draft.error;
    return (
      <View style={styles.center}>
        {error ? (
          <PageLoadFailure
            error={error}
            fallback={t`Could not load this page.`}
            gone={t`This page isn't available`}
            onRetry={() => void (draftId ? draft : review).refetch()}
          />
        ) : (
          <ActivityIndicator color={tokens.mutedForeground} />
        )}
      </View>
    );
  }
  const publishError = draftId && publish.input === draftId ? publish.error : null;
  const problem = publishError ?? document.error;
  return (
    <View style={[styles.screen, { backgroundColor: tokens.background }]}>
      <View
        style={showComments ? [StyleSheet.absoluteFill, styles.hiddenViewer] : styles.screen}
        pointerEvents={showComments ? "none" : "auto"}
        accessibilityElementsHidden={showComments}
        importantForAccessibility={showComments ? "no-hide-descendants" : "auto"}
      >
        {draftId ? (
          <SettingsGroup>
            <SettingsRow
              title={t`Back to comments`}
              disabled={publish.pending}
              onPress={backToComments}
            />
          </SettingsGroup>
        ) : null}
        {problem ? (
          <Text accessibilityRole="alert" style={[styles.banner, { color: tokens.destructive }]}>
            {errorText(problem)}
          </Text>
        ) : null}
        {page.version !== page.currentVersion && !draftId ? (
          <Text
            style={[styles.banner, { color: tokens.mutedForeground }]}
          >{t`Revision ${ph({ version: page.version })}`}</Text>
        ) : null}
        {document.data && source !== undefined ? (
          <SandboxedHtmlPreview
            html={document.data}
            background={tokens.background}
            onMessage={
              draftId
                ? undefined
                : (raw) => {
                    const sections = pageReviewSections(pageMessage(raw));
                    if (sections) setAnchors({ version: page.version, sections });
                  }
            }
          />
        ) : !document.isError ? (
          <ActivityIndicator color={tokens.mutedForeground} />
        ) : null}
      </View>
      {showComments ? (
        <PageReviewComments
          page={page}
          sections={sections}
          onRevision={(version, anchor) => {
            setRevision({ version, anchor });
            setShowComments(false);
          }}
          onLatest={backToLatest}
          onDraft={(id) => {
            publish.reset();
            setDraftId(id);
            setShowComments(false);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  hiddenViewer: { opacity: 0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  banner: { padding: 12, textAlign: "center" },
});
