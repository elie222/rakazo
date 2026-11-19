import { Trans, useLingui } from "@lingui/react/macro";
import type { PageComment, PageReview, PageSectionAnchor } from "@rakazo/contracts";
import type { PageCommentSubmission } from "@rakazo/core";
import {
  ensureAiDataConsent,
  pageCommentActions,
  pageCommentSubmission,
  pageSectionChoices,
} from "@rakazo/core";
import { pageCommentStatusLabel } from "@rakazo/i18n/page-review";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  OptionSelect,
  Spinner,
  Textarea,
} from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Ellipsis } from "lucide-react";
import { useRef, useState } from "react";
import { promptDataConsent } from "../../lib/calls/voice-consent";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

type CommentAction =
  | { kind: "resolve"; id: string; resolved: boolean }
  | { kind: "ask"; id: string; retryOf?: string }
  | ({ kind: "add" } & PageCommentSubmission);

export function PageReviewComments({
  page,
  sections,
  onRevision,
  onDraft,
}: {
  page: PageReview;
  sections: PageSectionAnchor[];
  onRevision: (version: number, anchor: PageSectionAnchor) => void;
  onDraft: (id: string) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
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
      if (action.kind === "resolve")
        return rpc.pageReviews.resolve({ pageId, commentId: action.id, resolved: action.resolved });
      if (action.kind === "ask") {
        await ensureAiDataConsent({
          uses: ["model"],
          status: () => rpc.aiConsent.status({ pageId, uses: ["model"] }),
          prompt: promptDataConsent,
          allow: (input) => rpc.aiConsent.allow({ ...input, pageId }),
        });
        return rpc.pageReviews.askRevision({
          pageId,
          commentId: action.id,
          retryOf: action.retryOf,
        });
      }
      await rpc.pageReviews.comment({
        pageId,
        submissionId: action.submissionId,
        version: action.version,
        section: action.section,
        sectionOccurrence: action.sectionOccurrence,
        body: action.body,
      });
    },
    stale: [queries.pageReviews.comments.key(), queries.pageReviews.get.key()],
    onSaved: (_, action) => {
      if (action.kind === "add") {
        setBody("");
        lastSubmission.current = undefined;
      }
    },
  });
  const current = page.currentVersion === page.version;
  const choices = pageSectionChoices(sections);
  const selected = choices.find(({ value }) => value === section);
  const anchor = choices.length ? selected?.anchor : { section: sectionName };
  const canPost = !save.pending && Boolean(anchor?.section.trim() && body.trim());
  const rows = comments.isError ? [] : (comments.data?.pages.flatMap(({ items }) => items) ?? []);
  const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  return (
    <div className="flex flex-col gap-3">
      {current ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canPost || !anchor) return;
            const submission = pageCommentSubmission(
              { version: page.version, ...anchor, body },
              lastSubmission.current,
            );
            lastSubmission.current = submission;
            save.run({ kind: "add", ...submission });
          }}
        >
          {sections.length ? (
            <OptionSelect
              aria-label={t`Section`}
              options={[{ value: "", label: t`Choose a section`, disabled: true }, ...choices]}
              value={selected?.value ?? ""}
              onValueChange={setSection}
              disabled={save.pending}
            />
          ) : (
            <Input
              aria-label={t`Section`}
              placeholder={t`Section name`}
              maxLength={200}
              value={sectionName}
              readOnly={save.pending}
              onChange={(event) => setSectionName(event.target.value)}
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
        <ul className="divide-y border-t border-border">
          {rows.map((comment) => {
            const { canResolve, canAsk, draftId } = pageCommentActions(page, comment);
            return (
              <li key={comment.id} className="flex flex-col gap-1 py-2">
                <div className="flex min-h-6 items-center gap-2 text-label text-muted-foreground">
                  <span className="truncate font-medium text-foreground">
                    {comment.author || t`Deleted account`}
                  </span>
                  <time
                    className="shrink-0"
                    dateTime={comment.createdAt}
                    title={new Date(comment.createdAt).toLocaleString()}
                  >
                    {date.format(new Date(comment.createdAt))}
                  </time>
                  {draftId || canAsk || canResolve ? (
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-xs" />}
                        className="ms-auto text-muted-foreground"
                        aria-label={t`Comment actions`}
                        disabled={save.pending}
                      >
                        <Ellipsis className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-max">
                        {draftId ? (
                          <DropdownMenuItem onClick={() => onDraft(draftId)}>
                            <Trans>Preview draft</Trans>
                          </DropdownMenuItem>
                        ) : null}
                        {canAsk ? (
                          <DropdownMenuItem
                            onClick={() =>
                              save.run({
                                kind: "ask",
                                id: comment.id,
                                retryOf: comment.revision?.id,
                              })
                            }
                          >
                            <Trans>Ask bot to revise</Trans>
                          </DropdownMenuItem>
                        ) : null}
                        {canResolve ? (
                          <DropdownMenuItem
                            onClick={() =>
                              save.run({
                                kind: "resolve",
                                id: comment.id,
                                resolved: !comment.resolvedAt,
                              })
                            }
                          >
                            {comment.resolvedAt ? <Trans>Reopen</Trans> : <Trans>Resolve</Trans>}
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                <p className="whitespace-pre-wrap break-words text-body">{comment.body}</p>
                <div className="flex flex-wrap items-center gap-x-2">
                  <Button
                    variant="text"
                    size="xs"
                    className="min-w-0 max-w-full justify-start gap-2"
                    onClick={() =>
                      onRevision(comment.version, {
                        section: comment.section,
                        sectionOccurrence: comment.sectionOccurrence,
                      })
                    }
                  >
                    <span className="truncate">{comment.section}</span>
                    <span className="shrink-0 font-normal">
                      <Trans>Revision {comment.version}</Trans>
                    </span>
                  </Button>
                  <ReviewStatus comment={comment} currentVersion={page.currentVersion} />
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
