import { Trans, useLingui } from "@lingui/react/macro";
import type { PageReview, PageSectionAnchor } from "@rakazo/contracts";
import { PAGE_REVISION_NOT_FOUND, pageReviewPath, pageRevisionFloor } from "@rakazo/contracts";
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
import type { Query, QueryClient } from "@tanstack/react-query";
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
  if (
    code === "NOT_FOUND" ||
    code === PAGE_REVISION_NOT_FOUND ||
    code === "FORBIDDEN" ||
    code === "UNAUTHORIZED"
  )
    return true;
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  return status === 401 || status === 403 || status === 404;
}

/**
 * Whether a cached payload is a revision the reviewer may no longer read: one below the lowest
 * revision the server just confirmed readable, or one whose revision is unknown.
 */
function isUnreadable(payload: unknown, floor: number): boolean {
  if (payload === undefined || payload === null) return false;
  return !(
    typeof payload === "object" &&
    "version" in payload &&
    typeof payload.version === "number" &&
    payload.version >= floor
  );
}

/** The pictures a cached revision names, by id. */
function namedImages(payload: unknown): string[] {
  const images =
    payload && typeof payload === "object" && "images" in payload ? payload.images : undefined;
  return images && typeof images === "object"
    ? Object.values(images).filter((id): id is string => typeof id === "string")
    : [];
}

/**
 * Stops these queries' reads in flight and restores nothing. A query whose last view unmounts while
 * it reads gets back the state from before that read, which would undo what is cleared next.
 */
function stopReads(queryClient: QueryClient, queries: Query[]): Promise<void> {
  return queryClient.cancelQueries(
    { predicate: (query) => queries.includes(query) },
    { revert: false, silent: true },
  );
}

/** Pages shared with the reviewer as the list query caches them. */
type SharedPageList = {
  pages: Array<{ items: Array<{ id: string; title: string }> }>;
};

/** Whether a value is a list of objects. */
function isObjectList(value: unknown): value is object[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "object" && entry !== null)
  );
}

/** Whether a cached list row holds text where its link and title read. */
function isSharedPageRow(value: unknown): value is { id: string; title: string } {
  if (typeof value !== "object" || value === null) return false;
  const { id, title } = value as { id?: unknown; title?: unknown };
  return typeof id === "string" && typeof title === "string";
}

/** Whether a cached payload is shaped as the list query stores it. Anything else is dropped whole. */
function isSharedPageList(payload: unknown): payload is SharedPageList {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "pages" in payload &&
    isObjectList(payload.pages) &&
    payload.pages.every(
      (page) => "items" in page && Array.isArray(page.items) && page.items.every(isSharedPageRow),
    )
  );
}

/** The list with one page under another title, or without the page when it has none to keep. */
function withPageTitle(list: SharedPageList, pageId: string, title: string | undefined) {
  return {
    ...list,
    pages: list.pages.map((page) => ({
      ...page,
      items: page.items.flatMap((item) => {
        if (item.id !== pageId) return [item];
        return title === undefined ? [] : [{ ...item, title }];
      }),
    })),
  };
}

/**
 * The title of the newest revision still cached for a page. Of two reads at the same revision, the
 * one updated last gives the title: a page renamed without a new revision keeps its number.
 */
function newestCachedTitle(queries: Query[]): string | undefined {
  let version = -1;
  let updatedAt = -1;
  let title: string | undefined;
  for (const { state } of queries) {
    const cached = state.data as PageReview | undefined;
    // A revision whose title is not text gives none, as a list row could show none.
    if (typeof cached?.title !== "string") continue;
    if (
      cached.version > version ||
      (cached.version === version && state.dataUpdatedAt >= updatedAt)
    ) {
      version = cached.version;
      updatedAt = state.dataUpdatedAt;
      title = cached.title;
    }
  }
  return title;
}

/** A cached `pageReviews.<procedure>` read of one reviewer in any Space, of one page when named. */
function isReviewerPageQuery(
  queryKey: readonly unknown[],
  userSegment: unknown,
  procedure: "get" | "comments" | "image" | "list",
  pageId?: string,
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
    path[3] !== procedure
  ) {
    return false;
  }
  if (pageId === undefined) return true;
  // A picture's key names its page next to the path, and the picture after it.
  if (procedure === "image") return queryKey[2] === pageId;
  const options = queryKey[1];
  if (!options || typeof options !== "object" || !("input" in options)) return false;
  const input = (options as { input?: unknown }).input;
  return Boolean(
    input && typeof input === "object" && (input as { pageId?: unknown }).pageId === pageId,
  );
}

function isSameReviewerPageReviewQuery(
  queryKey: readonly unknown[],
  userSegment: unknown,
  pageId: string,
  versionFilter?: { version: number | undefined },
): boolean {
  if (!isReviewerPageQuery(queryKey, userSegment, "get", pageId)) return false;
  if (!versionFilter) return true;
  const input = (queryKey[1] as { input: { version?: unknown } }).input;
  return input.version === versionFilter.version;
}

type PageDenialRecord = {
  activeReads: number;
  generation: number;
  spaceSegment: string | undefined;
  error: unknown;
};

const pageDenials = new WeakMap<QueryClient, Map<string, PageDenialRecord>>();

function pageDenialKey(userSegment: unknown, pageId: string, version?: number): string {
  const base = `${typeof userSegment === "string" ? userSegment : ""}\0${pageId}`;
  return version === undefined ? base : `${base}\0v:${version}`;
}

function beginPageRead(queryClient: QueryClient, key: string): number {
  let map = pageDenials.get(queryClient);
  if (!map) {
    map = new Map();
    pageDenials.set(queryClient, map);
  }
  const existing = map.get(key);
  if (existing) {
    existing.activeReads += 1;
    return existing.generation;
  }
  map.set(key, { activeReads: 1, generation: 0, spaceSegment: undefined, error: undefined });
  return 0;
}

function endPageRead(queryClient: QueryClient, key: string): void {
  const map = pageDenials.get(queryClient);
  const existing = map?.get(key);
  if (!map || !existing) return;
  existing.activeReads -= 1;
  if (existing.activeReads <= 0) {
    map.delete(key);
    if (map.size === 0) pageDenials.delete(queryClient);
  }
}

function getPageDenial(queryClient: QueryClient, key: string): PageDenialRecord | undefined {
  return pageDenials.get(queryClient)?.get(key);
}

function recordPageDenial(
  queryClient: QueryClient,
  key: string,
  spaceSegment: string | undefined,
  error: unknown,
): void {
  const existing = pageDenials.get(queryClient)?.get(key);
  if (!existing) return;
  existing.generation += 1;
  existing.spaceSegment = spaceSegment;
  existing.error = error;
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
      const currentPath = queries.pageReviews.get.key()[0];
      const userSegment = Array.isArray(currentPath) ? currentPath[0] : undefined;
      const spaceSegment =
        Array.isArray(currentPath) && typeof currentPath[1] === "string"
          ? currentPath[1]
          : undefined;
      const matchingQueries = () =>
        queryClient.getQueryCache().findAll({
          predicate: (query) => isReviewerPageQuery(query.queryKey, userSegment, "get", pageId),
        });
      const matchingComments = () =>
        queryClient.getQueryCache().findAll({
          predicate: (query) =>
            isReviewerPageQuery(query.queryKey, userSegment, "comments", pageId),
        });
      const sharedPageLists = () =>
        queryClient.getQueryCache().findAll({
          predicate: (query) => isReviewerPageQuery(query.queryKey, userSegment, "list"),
        });
      const pageImages = () =>
        queryClient.getQueryCache().findAll({
          predicate: (query) => isReviewerPageQuery(query.queryKey, userSegment, "image", pageId),
        });
      const denialKey = pageDenialKey(userSegment, pageId);
      const revisionDenialKey =
        version !== undefined ? pageDenialKey(userSegment, pageId, version) : undefined;
      const startGeneration = beginPageRead(queryClient, denialKey);
      const startRevisionGeneration =
        revisionDenialKey !== undefined ? beginPageRead(queryClient, revisionDenialKey) : 0;
      let fetched: PageReview;
      try {
        try {
          fetched = await read.queryFn!(context);
        } catch (error) {
          if (isUnavailablePageError(error)) {
            const floor = pageRevisionFloor(error);
            const revisionOnly = revisionDenialKey !== undefined && floor !== undefined;
            const comments = matchingComments();
            const lists = sharedPageLists();
            // Under a floor, a revision stays cached when it is neither the refused one nor below
            // the floor.
            const stays = (query: Query, from: number) =>
              !isSameReviewerPageReviewQuery(query.queryKey, userSegment, pageId, { version }) &&
              !isUnreadable(query.state.data, from);
            // A picture stays cached only when a revision that stays names it. Every other picture
            // of the page goes with the revisions the refusal drops, whatever revision named it last.
            const staying = revisionOnly
              ? matchingQueries().filter((query) => stays(query, floor))
              : [];
            const named = new Set(staying.flatMap((query) => namedImages(query.state.data)));
            const images = pageImages().filter((query) => {
              const id = query.queryKey[3];
              return !(typeof id === "string" && named.has(id));
            });
            await stopReads(queryClient, [...comments, ...lists, ...images]);
            // The cached comments can hold revisions the reviewer may no longer read, whatever the
            // refusal says about the page itself, so they never outlive a refusal.
            for (const query of [...comments, ...images]) {
              query.setState({ data: undefined, dataUpdatedAt: 0, fetchStatus: "idle" });
            }
            if (revisionOnly) {
              // Only the server's own answer for an unreadable revision, given after it checked the
              // page is still readable, spares the other revisions: it names the lowest one the
              // reviewer may still read. Drop the refused revision and every cached payload below
              // that floor, whichever key it is stored under, and invalidate the rest so accessible
              // views revalidate against the server.
              recordPageDenial(queryClient, revisionDenialKey, spaceSegment, error);
              for (const query of matchingQueries()) {
                if (!stays(query, floor)) {
                  query.setState({ data: undefined, dataUpdatedAt: 0 });
                }
              }
              void queryClient.invalidateQueries({
                predicate: (query) =>
                  isSameReviewerPageReviewQuery(query.queryKey, userSegment, pageId) &&
                  !isSameReviewerPageReviewQuery(query.queryKey, userSegment, pageId, { version }),
              });
            } else {
              recordPageDenial(queryClient, denialKey, spaceSegment, error);
              // Any other refusal names no floor a client can trust: a revoked grant, an older
              // server and a refusal without a usable detail all answer alike. Drop every cached
              // revision payload for this reviewer and page across Spaces so failed retries,
              // remounts, or Space switches while offline cannot resurface a revoked page before a
              // new authorized read succeeds.
              for (const query of matchingQueries()) {
                query.setState({ data: undefined, dataUpdatedAt: 0 });
              }
            }
            // A list of shared pages still names this page. Once the revisions below the floor are
            // dropped, its row keeps the title of the newest revision left cached; without one, the
            // row goes.
            const title = revisionOnly ? newestCachedTitle(matchingQueries()) : undefined;
            for (const query of lists) {
              query.setState({
                data: isSharedPageList(query.state.data)
                  ? withPageTitle(query.state.data, pageId, title)
                  : undefined,
                fetchStatus: "idle",
              });
            }
            void queryClient.invalidateQueries({ predicate: (query) => lists.includes(query) });
          }
          throw error;
        }
        const latestDenial = getPageDenial(queryClient, denialKey);
        if (
          latestDenial &&
          latestDenial.generation !== startGeneration &&
          !(fetched.owner && latestDenial.spaceSegment !== spaceSegment)
        ) {
          // Reject same-Space or non-owner reads started before a 401/403/404 denial so an in-flight
          // pre-revocation response cannot repopulate the cache; a retry started afterward or an
          // independently authorized owner read in another Space still succeeds.
          throw latestDenial.error;
        }
        if (revisionDenialKey !== undefined) {
          const latestRevisionDenial = getPageDenial(queryClient, revisionDenialKey);
          if (
            latestRevisionDenial &&
            latestRevisionDenial.generation !== startRevisionGeneration &&
            !(fetched.owner && latestRevisionDenial.spaceSegment !== spaceSegment)
          ) {
            throw latestRevisionDenial.error;
          }
        }
      } finally {
        endPageRead(queryClient, denialKey);
        if (revisionDenialKey !== undefined) endPageRead(queryClient, revisionDenialKey);
      }
      let newest = fetched.currentVersion;
      const cachedQueries = matchingQueries();
      for (const query of cachedQueries) {
        const cached = query.state.data;
        if (
          cached &&
          typeof cached === "object" &&
          "currentVersion" in cached &&
          typeof cached.currentVersion === "number" &&
          cached.currentVersion > newest
        ) {
          newest = cached.currentVersion;
        }
      }
      // Keep every cached revision of this page aware of the newest observed currentVersion so
      // reopening the review while offline cannot treat a stale cached revision as current.
      for (const query of cachedQueries) {
        const cached = query.state.data;
        if (
          cached &&
          typeof cached === "object" &&
          "currentVersion" in cached &&
          typeof cached.currentVersion === "number" &&
          cached.currentVersion < newest
        ) {
          query.setState({ data: { ...cached, currentVersion: newest } });
        }
      }
      return newest > fetched.currentVersion ? { ...fetched, currentVersion: newest } : fetched;
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
  const readerState =
    draftId || !page || page.version !== latestKnownVersion ? undefined : page.readerState;
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
