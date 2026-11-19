import { Trans, useLingui } from "@lingui/react/macro";
import type { PageReview, PageSectionAnchor } from "@rakazo/contracts";
import { pageReviewPath } from "@rakazo/contracts";
import type { PageReviewSections } from "@rakazo/core";
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
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useMedia, usePageDocument } from "../../lib/pages/pages";
import { followStream } from "../../lib/query/follow-stream";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { spaceChanged } from "../../lib/query/space-changes";
import { errorText } from "../../lib/query/user-error";
import { PageNotice } from "./PageNotice";
import { PageReviewComments } from "./PageReviewComments";
import { PageView } from "./PageView";

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
  const read = queries.pageReviews.get.queryOptions({ input: { pageId, version } });
  const review = useQuery({ ...read, refetchOnMount: "always", refetchOnWindowFocus: "always" });
  const page = review.isError ? undefined : review.data;
  const draft = useQuery({
    ...queries.pageReviews.draft.queryOptions({ input: { pageId, requestId: draftId ?? "" } }),
    enabled: Boolean(page?.owner && draftId),
    gcTime: 0,
  });
  const { code, sections } = pageReviewContent({
    page,
    showingDraft: Boolean(draftId),
    draftCode: draft.isError ? undefined : draft.data?.code,
    reported: anchors,
  });
  const preview = usePageDocument(code, "card", false, 0, !draftId, revision?.anchor);
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
              <Button onClick={() => publish.run(draftId)} disabled={publish.pending || !code}>
                <Trans>Publish revision</Trans>
              </Button>
            </>
          ) : (
            <ReviewControls
              page={page}
              open={commentsOpen}
              setOpen={setCommentsOpen}
              sections={sections}
              onVersion={(version, anchor) => {
                setAnchors(undefined);
                setRevision(version !== undefined && anchor ? { version, anchor } : undefined);
              }}
              onDraft={setDraftId}
            />
          )
        ) : null
      }
      notice={
        review.isError ? (
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
      renameError={
        draftId && publish.input === draftId && publish.error ? errorText(publish.error) : null
      }
    />
  );
}

function ReviewControls({
  page,
  open,
  setOpen,
  sections,
  onVersion,
  onDraft,
}: {
  page: PageReview;
  open: boolean;
  setOpen: (open: boolean) => void;
  sections: PageSectionAnchor[];
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
