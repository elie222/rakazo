import { Trans, useLingui } from "@lingui/react/macro";
import type { PageReview, PageSectionAnchor } from "@rakazo/contracts";
import { pageReviewPath } from "@rakazo/contracts";
import type { PageCommentSubmission, PageReviewSections } from "@rakazo/core";
import { pageReviewContent } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  Spinner,
} from "@rakazo/ui-web";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { usePageStateSaver } from "../../lib/pages/page-state";
import { useMedia, usePageDocument, useReviewedPageContent } from "../../lib/pages/pages";
import { followStream } from "../../lib/query/follow-stream";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { spaceChanged } from "../../lib/query/space-changes";
import { errorCode, errorText } from "../../lib/query/user-error";
import { PageNotice } from "./PageNotice";
import type { PageCommentDraft, PageReviewCommentSave } from "./PageReviewComments";
import {
  EMPTY_PAGE_COMMENT_DRAFT,
  PageReviewComments,
  usePageReviewCommentSave,
} from "./PageReviewComments";
import { PageView } from "./PageView";

function isUnavailablePageError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "NOT_FOUND" || code === "FORBIDDEN" || code === "UNAUTHORIZED") return true;
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  return status === 401 || status === 403 || status === 404;
}

function isSameReviewerPageReviewQuery(
  queryKey: readonly unknown[],
  userSegment: unknown,
  pageId: string,
): boolean {
  const path = queryKey[0];
  if (
    !Array.isArray(path) ||
    path.length !== 4 ||
    typeof userSegment !== "string" ||
    path[0] !== userSegment ||
    typeof path[1] !== "string" ||
    !path[1].startsWith("space:") ||
    path[2] !== "pageReviews" ||
    path[3] !== "get"
  ) {
    return false;
  }
  const options = queryKey[1];
  if (!options || typeof options !== "object" || !("input" in options)) return false;
  const input = (options as { input?: unknown }).input;
  return Boolean(
    input && typeof input === "object" && (input as { pageId?: unknown }).pageId === pageId,
  );
}

export default function PageReviewHost() {
  const { pageId } = useParams();
  const { state } = useLocation();
  const navigate = useNavigate();
  const queries = useSpaceQueries();
  const subscribe = queries.notifications.subscribe.call;
  useEffect(
    () =>
      followStream(
        (signal) => subscribe(undefined, { signal }),
        (frame) => {
          if (frame.type === "pages") void spaceChanged("pages");
        },
      ),
    [subscribe],
  );
  const onClose = () => {
    if (state?.returnToPrevious === true) void navigate(-1);
    else void navigate(pageId ? "/review" : "/app", { replace: true });
  };
  return pageId ? (
    <ReviewPage key={pageId} pageId={pageId} onClose={onClose} />
  ) : (
    <SharedPages onClose={onClose} />
  );
}

function ReviewPage({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const compact = useMedia("(pointer: coarse)");
  const [revision, setRevision] = useState<{ version: number; anchor: PageSectionAnchor }>();
  const version = revision?.version;
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [draftId, setDraftId] = useState<string>();
  const [anchors, setAnchors] = useState<PageReviewSections>();
  const queryClient = useQueryClient();
  const [commentDraft, setCommentDraft] = useState<PageCommentDraft>(EMPTY_PAGE_COMMENT_DRAFT);
  const lastSubmission = useRef<PageCommentSubmission>(undefined);
  const read = queries.pageReviews.get.queryOptions({ input: { pageId, version } });
  const review = useQuery({
    ...read,
    queryFn: async (context) => {
      try {
        return await read.queryFn!(context);
      } catch (error) {
        if (isUnavailablePageError(error)) {
          // Drop every cached revision payload for this reviewer and page across Spaces so failed
          // retries, remounts, or Space switches while offline cannot resurface a revoked page
          // before a new authorized read succeeds.
          const currentPath = queries.pageReviews.get.key()[0];
          const userSegment = Array.isArray(currentPath) ? currentPath[0] : undefined;
          for (const query of queryClient.getQueryCache().findAll({
            predicate: (query) =>
              isSameReviewerPageReviewQuery(query.queryKey, userSegment, pageId),
          })) {
            query.setState({ data: undefined, dataUpdatedAt: 0 });
          }
        }
        throw error;
      }
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });
  const unavailable = review.isError && (!review.data || isUnavailablePageError(review.error));
  const page = unavailable ? undefined : review.data;
  if (page && (commentDraft.version === null || page.currentVersion > commentDraft.version)) {
    setCommentDraft((current) => {
      if (current.version !== null && page.currentVersion <= current.version) return current;
      return {
        version: page.currentVersion,
        section: current.version === null ? current.section : "",
        sectionName: current.version === null ? current.sectionName : "",
        body: current.body,
      };
    });
  }
  const latestKnownVersion =
    page && commentDraft.version !== null
      ? Math.max(page.currentVersion, commentDraft.version)
      : page?.currentVersion;
  const reviewPage =
    page && latestKnownVersion !== undefined && latestKnownVersion !== page.currentVersion
      ? { ...page, currentVersion: latestKnownVersion }
      : page;
  const commentSave = usePageReviewCommentSave({
    pageId,
    onAdded: () => {
      setCommentDraft((current) => ({ ...EMPTY_PAGE_COMMENT_DRAFT, version: current.version }));
      lastSubmission.current = undefined;
    },
  });
  const draft = useQuery({
    ...queries.pageReviews.draft.queryOptions({ input: { pageId, requestId: draftId ?? "" } }),
    enabled: Boolean(page?.owner && draftId),
    gcTime: 0,
  });
  const { shown, sections } = pageReviewContent({
    page,
    showingDraft: Boolean(draftId),
    draft: draft.isError ? undefined : draft.data,
    reported: anchors,
  });
  const readerState = draftId ? undefined : page?.readerState;
  const preview = usePageDocument(
    useReviewedPageContent(pageId, shown),
    "card",
    false,
    0,
    !draftId,
    revision?.anchor,
    readerState,
  );
  const stateSaver = usePageStateSaver(pageId, read.queryKey);
  const publish = useSave({
    save: (requestId: string, rpc) => rpc.pageReviews.publish({ pageId, requestId }),
    stale: [
      queries.pageReviews.get.key(),
      queries.pageReviews.comments.key(),
      queries.pages.get.key(),
    ],
    onSaved: () => {
      setDraftId(undefined);
      setRevision(undefined);
      setCommentsOpen(true);
    },
  });

  return (
    <PageView
      open
      compact={compact}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={page?.title ?? ""}
      document={preview.document}
      onSaveState={readerState ? stateSaver.save : undefined}
      onSections={
        page && !draftId ? (sections) => setAnchors({ version: page.version, sections }) : undefined
      }
      share={
        page ? (
          draftId ? (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraftId(undefined);
                  setCommentsOpen(true);
                }}
                disabled={publish.pending}
              >
                <Trans>Back to comments</Trans>
              </Button>
              <Button onClick={() => publish.run(draftId)} disabled={publish.pending || !shown}>
                <Trans>Publish revision</Trans>
              </Button>
            </>
          ) : (
            <ReviewControls
              page={reviewPage!}
              open={commentsOpen}
              setOpen={setCommentsOpen}
              sections={sections}
              draft={commentDraft}
              onDraftChange={setCommentDraft}
              lastSubmission={lastSubmission}
              commentSave={commentSave}
              onVersion={(version, anchor) => {
                setAnchors(undefined);
                if (version !== undefined && anchor) {
                  setRevision({ version, anchor });
                  return;
                }
                setRevision(undefined);
                void queryClient.invalidateQueries({
                  queryKey: queries.pageReviews.get.queryKey({
                    input: { pageId, version: undefined },
                  }),
                });
              }}
              onDraft={setDraftId}
            />
          )
        ) : null
      }
      notice={
        unavailable ? (
          <PageNotice
            title={t`This page isn't available`}
            detail={errorText(review.error)}
            onRetry={() => void review.refetch()}
            onClose={onClose}
          />
        ) : draft.isError && draftId ? (
          <PageNotice
            title={t`This draft isn't available`}
            detail={errorText(draft.error)}
            onClose={() => setDraftId(undefined)}
          />
        ) : preview.failed ? (
          <PageNotice
            title={t`This page couldn't load`}
            detail={t`Check your connection and try again.`}
            onRetry={preview.retry}
            onClose={onClose}
          />
        ) : null
      }
      titleError={
        draftId && publish.input === draftId && publish.error
          ? errorText(publish.error)
          : stateSaver.failed && readerState
            ? t`Your changes aren't saved. Check your connection.`
            : review.isError && page
              ? errorText(review.error)
              : null
      }
    />
  );
}

function ReviewControls({
  page,
  open,
  setOpen,
  sections,
  draft,
  onDraftChange,
  lastSubmission,
  commentSave,
  onVersion,
  onDraft,
}: {
  page: PageReview;
  open: boolean;
  setOpen: (open: boolean) => void;
  sections: PageSectionAnchor[];
  draft: PageCommentDraft;
  onDraftChange: Dispatch<SetStateAction<PageCommentDraft>>;
  lastSubmission: RefObject<PageCommentSubmission | undefined>;
  commentSave: PageReviewCommentSave;
  onVersion: (next?: number, anchor?: PageSectionAnchor) => void;
  onDraft: (id: string) => void;
}) {
  const { t } = useLingui();
  return (
    <>
      {page.version !== page.currentVersion ? (
        <Button variant="outline" onClick={() => onVersion()}>
          <Trans>Back to latest</Trans>
        </Button>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label={t`Comments`}
          render={<Button variant="outline" size="icon-lg" className="rounded-full" />}
        >
          <MessageSquare className="size-4" />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="max-h-[75dvh] w-[390px] max-w-[calc(100vw-24px)] overflow-y-auto"
        >
          <PopoverTitle>
            <Trans>Comments</Trans>
          </PopoverTitle>
          {open ? (
            <PageReviewComments
              page={page}
              sections={sections}
              draft={draft}
              onDraftChange={onDraftChange}
              lastSubmission={lastSubmission}
              save={commentSave}
              onRevision={(version, section) => {
                setOpen(false);
                onVersion(version, section);
              }}
              onDraft={(id) => {
                setOpen(false);
                onDraft(id);
              }}
            />
          ) : null}
        </PopoverContent>
      </Popover>
    </>
  );
}

function SharedPages({ onClose }: { onClose: () => void }) {
  const queries = useSpaceQueries();
  const pages = useInfiniteQuery({
    ...queries.pageReviews.list.infiniteOptions({
      input: (cursor: string | null) => (cursor ? { cursor } : {}),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
    }),
    refetchOnMount: "always",
  });
  const items = pages.isError ? [] : (pages.data?.pages.flatMap(({ items }) => items) ?? []);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>
          <Trans>Pages shared with you</Trans>
        </DialogTitle>
        {pages.isError ? (
          <div className="flex flex-col items-start gap-2">
            <p role="alert">{errorText(pages.error)}</p>
            <Button
              variant="outline"
              disabled={pages.isFetching}
              onClick={() => void pages.refetch()}
            >
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : pages.isPending ? (
          <Spinner />
        ) : items.length === 0 ? (
          <p>
            <Trans>No pages shared with you yet.</Trans>
          </p>
        ) : (
          <ul className="max-h-[55dvh] overflow-y-auto">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  className="block truncate rounded-md p-2 hover:bg-accent"
                  to={pageReviewPath(item.id)}
                  state={{ returnToPrevious: true }}
                >
                  {item.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {!pages.isError && pages.hasNextPage ? (
          <Button
            variant="outline"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            <Trans>Show more</Trans>
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
