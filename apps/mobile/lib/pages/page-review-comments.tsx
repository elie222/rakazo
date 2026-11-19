import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { PageComment, PageReview } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsRow,
} from "../../components/settings/settings-group";
import { errorText } from "../api/user-error";
import { useMobileTokens } from "../native/native";
import { targetRpcQuery, useSave } from "../query/query";
import { useScreenQuery } from "../query/screen-query";
import { ACCOUNT_SETTINGS } from "../query/settings-target";

type CommentAction =
  | { kind: "resolve"; id: string; resolved: boolean }
  | { kind: "ask"; id: string }
  | { kind: "add"; id: string; section: string; body: string };

export function PageReviewComments({
  page,
  sections,
  onRevision,
  onLatest,
  onDraft,
}: {
  page: PageReview;
  sections: string[];
  onRevision: (version: number, section: string) => void;
  onLatest: () => void;
  onDraft: (commentId: string) => void;
}) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [cursor, setCursor] = useState<string>();
  const [section, setSection] = useState("");
  const [body, setBody] = useState("");
  const [id, setId] = useState(newClientId);
  const [composingVersion, setComposingVersion] = useState(page.version);
  if (composingVersion !== page.version) {
    setComposingVersion(page.version);
    setSection("");
    setId(newClientId());
  }
  const [choosingSection, setChoosingSection] = useState(false);
  const pageId = page.id;
  const read = targetRpcQuery(ACCOUNT_SETTINGS, "pageReviews/comments", { pageId, cursor });
  const comments = useScreenQuery(read);
  const save = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (action: CommentAction, send) => {
      const commentId = action.id;
      if (action.kind === "ask") return send("pageReviews/askRevision", { pageId, commentId });
      if (action.kind === "resolve")
        return send("pageReviews/resolve", { pageId, commentId, resolved: action.resolved });
      await send("pageReviews/comment", {
        pageId,
        submissionId: commentId,
        body: action.body,
        section: action.section,
        version: page.version,
      });
    },
    stale: [read.queryKey],
    onSaved: (_, action) => {
      if (action.kind === "add") {
        setBody("");
        setId(newClientId());
        setCursor(undefined);
      }
    },
  });
  const current = page.currentVersion === page.version;
  const next = comments.isError ? null : comments.data?.nextCursor;
  const rows = comments.isError ? [] : (comments.data?.items ?? []);
  const failure = save.error ?? comments.error;
  if (choosingSection)
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <SettingsGroup label={t`Section`}>
          {sections.map((label) => (
            <SettingsRow
              key={label}
              title={label}
              accessibilityRole="radio"
              accessibilityState={{ checked: section === label }}
              onPress={() => {
                setSection(label);
                setChoosingSection(false);
              }}
            />
          ))}
        </SettingsGroup>
      </ScrollView>
    );
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      {current ? (
        <SettingsGroup>
          {sections.length ? (
            <SettingsRow
              key="section"
              title={t`Section`}
              value={sections.includes(section) ? section : undefined}
              chevron="right"
              disabled={save.pending}
              onPress={() => setChoosingSection(true)}
            />
          ) : (
            <SettingsInputRow
              key="section"
              accessibilityLabel={t`Section name`}
              placeholder={t`Section name`}
              maxLength={200}
              value={section}
              editable={!save.pending}
              onChangeText={setSection}
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
            disabled={
              save.pending ||
              !body.trim() ||
              !(sections.length ? sections.includes(section) : section.trim())
            }
            onPress={() =>
              save.run({ kind: "add", id, section: section.trim(), body: body.trim() })
            }
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
        const canAct = page.owner || comment.mine;
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
              onPress={() => onRevision(version, comment.section)}
            />
            {page.owner &&
            current &&
            version === page.version &&
            comment.revision?.status === "ready" ? (
              <SettingsRow
                key="draft"
                title={t`Preview draft`}
                chevron="right"
                onPress={() => onDraft(comment.id)}
              />
            ) : null}
            {canAct &&
            page.canRequestRevision &&
            current &&
            version === page.version &&
            !comment.revision &&
            !comment.resolvedAt ? (
              <SettingsRow
                key="ask"
                title={t`Ask bot to revise`}
                disabled={save.pending}
                onPress={() => save.run({ kind: "ask", id: comment.id })}
              />
            ) : null}
            {canAct ? (
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
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const request = comment.revision;
  const label =
    request?.status === "published" && request.resultVersion !== null
      ? t`Published in revision ${ph({ version: request.resultVersion })}`
      : request?.status === "cancelled"
        ? t`Request cancelled`
        : comment.version !== latest
          ? t`Earlier revision`
          : request?.status === "pending"
            ? t`Bot draft requested`
            : request?.status === "ready"
              ? t`Draft ready`
              : request?.status === "failed"
                ? t`Bot couldn't draft a revision`
                : comment.resolvedAt
                  ? t`Resolved`
                  : null;
  return label ? <Text style={{ color: tokens.mutedForeground }}>{label}</Text> : null;
}

const styles = StyleSheet.create({
  content: { paddingVertical: 16, gap: 12 },
  comment: { padding: 16, gap: 6 },
  notice: { paddingHorizontal: 20 },
});
