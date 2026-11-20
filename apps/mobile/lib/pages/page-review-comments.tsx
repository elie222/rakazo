import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { PageComment, PageReview, PageSectionAnchor } from "@rakazo/contracts";
import type { PageCommentSubmission } from "@rakazo/core";
import { pageCommentActions, pageCommentSubmission, pageSectionChoices } from "@rakazo/core";
import { pageCommentStatusLabel } from "@rakazo/i18n/page-review";
import { useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsRow,
} from "../../components/settings/settings-group";
import { MenuPicker } from "../../components/ui/menu-picker";
import { errorText } from "../api/user-error";
import { useMobileTokens } from "../native/native";
import { targetRpcQuery, useSave } from "../query/query";
import { useScreenQuery } from "../query/screen-query";
import { ACCOUNT_SETTINGS } from "../query/settings-target";

type CommentAction =
  | { kind: "resolve"; id: string; resolved: boolean }
  | { kind: "ask"; id: string; retryOf?: string }
  | ({ kind: "add" } & PageCommentSubmission);

export function PageReviewComments({
  page,
  sections,
  onRevision,
  onLatest,
  onDraft,
}: {
  page: PageReview;
  sections: PageSectionAnchor[];
  onRevision: (version: number, anchor: PageSectionAnchor) => void;
  onLatest: () => void;
  onDraft: (commentId: string) => void;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [cursor, setCursor] = useState<string>();
  const [section, setSection] = useState("");
  const [sectionName, setSectionName] = useState("");
  const [body, setBody] = useState("");
  const lastSubmission = useRef<PageCommentSubmission>(undefined);
  const [composingVersion, setComposingVersion] = useState(page.version);
  if (composingVersion !== page.version) {
    setComposingVersion(page.version);
    setSection("");
    setSectionName("");
    setBody("");
  }
  const pageId = page.id;
  const read = targetRpcQuery(ACCOUNT_SETTINGS, "pageReviews/comments", { pageId, cursor });
  const comments = useScreenQuery(read);
  const save = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (action: CommentAction, send) => {
      if (action.kind === "ask")
        return send("pageReviews/askRevision", {
          pageId,
          commentId: action.id,
          retryOf: action.retryOf,
        });
      if (action.kind === "resolve")
        return send("pageReviews/resolve", {
          pageId,
          commentId: action.id,
          resolved: action.resolved,
        });
      await send("pageReviews/comment", {
        pageId,
        submissionId: action.submissionId,
        body: action.body,
        section: action.section,
        sectionOccurrence: action.sectionOccurrence,
        version: action.version,
      });
    },
    // Match every cursor for this page, including the newest comments shown after posting.
    stale: [targetRpcQuery(ACCOUNT_SETTINGS, "pageReviews/comments", { pageId }).queryKey],
    onSaved: (_, action) => {
      if (action.kind === "add") {
        setBody("");
        lastSubmission.current = undefined;
        setCursor(undefined);
      }
    },
  });
  const current = page.currentVersion === page.version;
  const next = comments.isError ? null : comments.data?.nextCursor;
  const rows = comments.isError ? [] : (comments.data?.items ?? []);
  const failure = save.error ?? comments.error;
  const choices = pageSectionChoices(sections);
  const selected = choices.find(({ value }) => value === section);
  const anchor = choices.length ? selected?.anchor : { section: sectionName };
  const canPost = !save.pending && Boolean(anchor?.section.trim() && body.trim());
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      {current ? (
        <SettingsGroup>
          {sections.length ? (
            <MenuPicker
              key="section"
              label={t`Section`}
              placeholder={t`Choose a section`}
              choices={choices.map(({ value, label }) => ({ key: value, label }))}
              value={section}
              disabled={save.pending}
              onChange={setSection}
            />
          ) : (
            <SettingsInputRow
              key="section"
              accessibilityLabel={t`Section name`}
              placeholder={t`Section name`}
              maxLength={200}
              value={sectionName}
              editable={!save.pending}
              onChangeText={setSectionName}
            />
          )}
          <SettingsInputRow
            key="body"
            accessibilityLabel={t`Comment`}
            placeholder={t`Write a comment`}
            multiline
            maxLength={4000}
            value={body}
            editable={!save.pending}
            onChangeText={setBody}
          />
          <SettingsRow
            key="post"
            title={t`Post comment`}
            prominent
            disabled={!canPost}
            onPress={() => {
              if (!canPost || !anchor) return;
              const submission = pageCommentSubmission(
                { version: page.version, ...anchor, body },
                lastSubmission.current,
              );
              lastSubmission.current = submission;
              save.run({ kind: "add", ...submission });
            }}
          />
        </SettingsGroup>
      ) : (
        <SettingsGroup>
          <SettingsRow title={t`Back to latest`} onPress={onLatest} />
        </SettingsGroup>
      )}
      {failure ? (
        <Text accessibilityRole="alert" style={[styles.notice, { color: tokens.destructive }]}>
          {errorText(failure)}
        </Text>
      ) : null}
      {!comments.isPending && !failure && rows.length === 0 ? (
        <Text
          style={[styles.notice, { color: tokens.mutedForeground }]}
        >{t`No comments yet.`}</Text>
      ) : null}
      {rows.map((comment) => {
        const { canResolve, canAsk, draftId } = pageCommentActions(page, comment);
        const version = comment.version;
        return (
          <SettingsGroup key={comment.id}>
            <View key="body" style={styles.comment}>
              <Text style={{ color: tokens.foreground, fontWeight: "600" }}>{comment.section}</Text>
              <Text style={{ color: tokens.mutedForeground }}>
                {comment.author || t`Deleted account`}
              </Text>
              <Text style={{ color: tokens.mutedForeground }}>
                {new Date(comment.createdAt).toLocaleDateString()}
              </Text>
              <Text selectable style={{ color: tokens.foreground }}>
                {comment.body}
              </Text>
              <CommentStatus comment={comment} latest={page.currentVersion} />
            </View>
            <SettingsRow
              key="version"
              title={t`Revision ${ph({ version })}`}
              chevron="right"
              onPress={() =>
                onRevision(version, {
                  section: comment.section,
                  sectionOccurrence: comment.sectionOccurrence,
                })
              }
            />
            {draftId ? (
              <SettingsRow
                key="draft"
                title={t`Preview draft`}
                chevron="right"
                onPress={() => onDraft(draftId)}
              />
            ) : null}
            {canAsk ? (
              <SettingsRow
                key="ask"
                title={t`Ask bot to revise`}
                disabled={save.pending}
                onPress={() =>
                  save.run({ kind: "ask", id: comment.id, retryOf: comment.revision?.id })
                }
              />
            ) : null}
            {canResolve ? (
              <SettingsRow
                key="resolve"
                title={comment.resolvedAt ? t`Reopen` : t`Resolve`}
                disabled={save.pending}
                onPress={() =>
                  save.run({ kind: "resolve", id: comment.id, resolved: !comment.resolvedAt })
                }
              />
            ) : null}
          </SettingsGroup>
        );
      })}
      {cursor || next ? (
        <SettingsGroup>
          {cursor ? (
            <SettingsRow
              key="latest"
              title={t`Newest comments`}
              onPress={() => setCursor(undefined)}
            />
          ) : null}
          {next ? (
            <SettingsRow key="older" title={t`Older comments`} onPress={() => setCursor(next)} />
          ) : null}
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

function CommentStatus({ comment, latest }: { comment: PageComment; latest: number }) {
  const tokens = useMobileTokens();
  const label = pageCommentStatusLabel(comment, latest);
  return label ? <Text style={{ color: tokens.mutedForeground }}>{label}</Text> : null;
}

const styles = StyleSheet.create({
  content: { paddingVertical: 16, gap: 12 },
  comment: { padding: 16, gap: 6 },
  notice: { paddingHorizontal: 20 },
});
