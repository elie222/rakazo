import { Trans, useLingui } from "@lingui/react/macro";
import type { PageComment, PageReview } from "@rakazo/contracts";
import {
  canPostPageComment,
  ensureAiDataConsent,
  newClientId,
  pageCommentActions,
} from "@rakazo/core";
import { pageCommentStatusLabel } from "@rakazo/i18n/page-review";
import { Button, Input, OptionSelect, Spinner, Textarea } from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { promptDataConsent } from "../../lib/calls/voice-consent";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

type CommentAction =
  | { kind: "resolve"; id: string; resolved: boolean }
  | { kind: "ask"; id: string; retryOf?: string }
  | { kind: "add"; id: string; section: string; body: string };

export function PageReviewComments({
  page,
  sections,
  onRevision,
  onDraft,
}: {
  page: PageReview;
  sections: string[];
  onRevision: (version: number, section: string) => void;
  onDraft: (id: string) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [section, setSection] = useState("");
  const [body, setBody] = useState("");
  const [id, setId] = useState(newClientId);
  const [composingVersion, setComposingVersion] = useState(page.version);
  if (composingVersion !== page.version) {
    setComposingVersion(page.version);
    setSection("");
    setBody("");
    setId(newClientId());
  }
  const comments = useInfiniteQuery(
    queries.pageReviews.comments.infiniteOptions({
      input: (cursor: string | null) => ({ pageId: page.id, ...(cursor ? { cursor } : {}) }),
      initialPageParam: null as string | null,
      getNextPageParam: (result) => result.nextCursor,
    }),
  );
  const save = useSave({
    save: async (action: CommentAction, rpc) => {
      const pageId = page.id;
      const commentId = action.id;
      if (action.kind === "resolve")
        return rpc.pageReviews.resolve({ pageId, commentId, resolved: action.resolved });
      if (action.kind === "ask") {
        await ensureAiDataConsent({
          uses: ["model"],
          status: () => rpc.aiConsent.status({ pageId, uses: ["model"] }),
          prompt: promptDataConsent,
          allow: (input) => rpc.aiConsent.allow({ ...input, pageId }),
        });
        return rpc.pageReviews.askRevision({ pageId, commentId, retryOf: action.retryOf });
      }
      await rpc.pageReviews.comment({
        pageId,
        submissionId: commentId,
        version: page.version,
        section: action.section,
        body: action.body,
      });
    },
    stale: [queries.pageReviews.comments.key(), queries.pageReviews.get.key()],
    onSaved: (_, action) => {
      if (action.kind === "add") {
        setBody("");
        setId(newClientId());
      }
    },
  });
  const current = page.currentVersion === page.version;
  const canPost = !save.pending && canPostPageComment(sections, section, body);
  const rows = comments.isError ? [] : (comments.data?.pages.flatMap(({ items }) => items) ?? []);
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="flex flex-col gap-3">
      {current ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (canPost) save.run({ kind: "add", id, section: section.trim(), body: body.trim() });
          }}
        >
          {sections.length ? (
            <OptionSelect
              aria-label={t`Section`}
              options={[
                { value: "", label: t`Choose a section`, disabled: true },
                ...sections.map((value) => ({ value, label: value })),
              ]}
              value={sections.includes(section) ? section : ""}
              onValueChange={setSection}
              disabled={save.pending}
            />
          ) : (
            <Input
              aria-label={t`Section`}
              placeholder={t`Section name`}
              maxLength={200}
              value={section}
              readOnly={save.pending}
              onChange={(event) => setSection(event.target.value)}
            />
          )}
          <Textarea
            aria-label={t`Comment`}
            placeholder={t`Write a comment`}
            maxLength={4000}
            value={body}
            readOnly={save.pending}
            onChange={(event) => setBody(event.target.value)}
          />
          <Button type="submit" className="self-end" disabled={!canPost}>
            <Trans>Post comment</Trans>
          </Button>
        </form>
      ) : null}
      {save.error || comments.error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(save.error ?? comments.error)}
        </p>
      ) : null}
      {comments.isPending ? <Spinner /> : null}
      {rows.length ? (
        <ul className="divide-y">
          {rows.map((comment) => {
            const { canResolve, canAsk, draftId } = pageCommentActions(page, comment);
            return (
              <li key={comment.id} className="flex flex-col gap-1 py-3">
                <div className="break-words font-medium">{comment.section}</div>
                <div className="flex flex-wrap items-center gap-x-2 text-label text-muted-foreground">
                  <span>{comment.author || t`Deleted account`}</span>
                  <time dateTime={comment.createdAt}>
                    {date.format(new Date(comment.createdAt))}
                  </time>
                  <Button
                    variant="link"
                    size="xs"
                    onClick={() => onRevision(comment.version, comment.section)}
                  >
                    <Trans>Revision {comment.version}</Trans>
                  </Button>
                </div>
                <p className="whitespace-pre-wrap break-words text-body-sm">{comment.body}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <ReviewStatus comment={comment} currentVersion={page.currentVersion} />
                  {draftId ? (
                    <Button variant="outline" size="xs" onClick={() => onDraft(draftId)}>
                      <Trans>Preview draft</Trans>
                    </Button>
                  ) : null}
                  {canAsk ? (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={save.pending}
                      onClick={() =>
                        save.run({ kind: "ask", id: comment.id, retryOf: comment.revision?.id })
                      }
                    >
                      <Trans>Ask bot to revise</Trans>
                    </Button>
                  ) : null}
                  {canResolve ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={save.pending}
                      onClick={() =>
                        save.run({ kind: "resolve", id: comment.id, resolved: !comment.resolvedAt })
                      }
                    >
                      {comment.resolvedAt ? <Trans>Reopen</Trans> : <Trans>Resolve</Trans>}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {comments.hasNextPage ? (
        <Button
          variant="outline"
          disabled={comments.isFetchingNextPage}
          onClick={() => void comments.fetchNextPage()}
        >
          <Trans>Older comments</Trans>
        </Button>
      ) : null}
    </div>
  );
}

function ReviewStatus({
  comment,
  currentVersion,
}: {
  comment: PageComment;
  currentVersion: number;
}) {
  const label = pageCommentStatusLabel(comment, currentVersion);
  return label ? <span className="text-label text-muted-foreground">{label}</span> : null;
}
