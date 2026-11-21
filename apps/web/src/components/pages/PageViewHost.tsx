import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { pageMutationOptions } from "../../lib/page-actions";
import type { PageSession } from "../../lib/pages";
import { PAGE_PARAM, useMedia, usePageDocument, usePageSession } from "../../lib/pages";
import { useSpaceQueries } from "../../lib/query";
import { errorCode } from "../../lib/user-error";
import { PageNotice } from "./PageNotice";
import { PageView } from "./PageView";
import { SharePopover } from "./SharePopover";

const COARSE = "(pointer: coarse)";
/** A tablet: the page is a sheet over the chat, with the chat's composer docked over it. */
const SHEET = "(pointer: coarse) and (min-width: 900px)";
/** The docked composer's height plus its gap to the screen edge and to what scrolls above it. */
const DOCK_CLEARANCE = 72;

/** The page named in the URL, full screen over the chat with the chat's composer docked. */
export function PageViewHost() {
  const [searchParams] = useSearchParams();
  const pageId = searchParams.get(PAGE_PARAM);
  const session = usePageSession();
  // A key per opening so no state outlives it; the closing page keeps its id to animate out.
  const [view, setView] = useState({ pageId, shownId: pageId, opening: pageId ? 1 : 0 });
  if (view.pageId !== pageId) {
    setView({
      pageId,
      shownId: pageId ?? view.shownId,
      opening: pageId ? view.opening + 1 : view.opening,
    });
  }
  return view.shownId && session ? (
    <OpenPage key={view.opening} pageId={pageId} shownId={view.shownId} session={session} />
  ) : null;
}

function OpenPage({
  pageId,
  shownId,
  session,
}: {
  pageId: string | null;
  shownId: string;
  session: PageSession;
}) {
  const compact = useMedia(COARSE);
  const sheet = useMedia(SHEET);
  const { t } = useLingui();
  const [, setSearchParams] = useSearchParams();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const page = useQuery({
    ...queries.pages.get.queryOptions({ input: { pageId: shownId } }),
    enabled: pageId !== null,
  });
  // Another member's page is read-only, and a reply would go to a bot that cannot reach it.
  // compat-shim(after v0.12.0): an older server omits `mine` and opens only the caller's own pages.
  const owned = page.data?.mine !== false;
  const viewer = usePageDocument(
    page.data?.code,
    sheet ? "background" : "card",
    owned,
    DOCK_CLEARANCE,
  );
  const [shareOpen, setShareOpen] = useState(false);
  const link = useQuery({
    ...queries.pages.get.queryOptions({ input: { pageId: shownId, link: true } }),
    enabled: pageId !== null && shareOpen,
  });

  function close() {
    session.askShare(null);
    setShareOpen(false);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete(PAGE_PARAM);
      return next;
    });
  }

  // A page that is gone or not yours says so, rather than closing under the user. That includes a
  // page already shown, such as another member's page its owner stops sharing: a failed re-read
  // keeps the earlier data, so only a lost connection keeps showing it.
  const code = errorCode(page.error);
  const gone = page.isError && (code === "NOT_FOUND" || code === "FORBIDDEN");
  const failed = page.isError && (page.data === undefined || gone);

  const actions = pageMutationOptions(queries, queryClient);
  const rename = useMutation(actions.rename);
  const visibility = useMutation(actions.setVisibility);
  // A failed change may have been saved with only its answer lost: until the page is read again,
  // who can view it is unknown, and either choice is sent, so the link can always be turned off.
  const shownVisibility =
    visibility.isError && page.dataUpdatedAt < visibility.submittedAt
      ? null
      : (page.data?.visibility ?? null);

  // Share asked for with this page opens once it has loaded; any other request is dropped.
  const loaded = page.data !== undefined;
  useEffect(() => {
    if (loaded && pageId && session.takeShare(pageId)) setShareOpen(true);
  }, [loaded, pageId, session]);
  const setDockNode = useCallback(
    (node: HTMLDivElement | null) => session.dock.set({ node }),
    [session],
  );
  const data = page.data;
  const open = pageId !== null && (data !== undefined || failed || page.isPending);
  const dockPage = pageId !== null && data && owned ? { id: data.id, title: data.title } : null;
  useEffect(() => {
    session.dock.set({ page: dockPage });
    return () => session.dock.set({ page: null });
  }, [session, dockPage?.id, dockPage?.title]);
  return (
    <PageView
      open={open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={data?.title ?? ""}
      document={viewer.document}
      returnFocus={session.restoreFocus}
      compact={compact}
      notice={
        gone ? (
          <PageNotice
            title={t`This page isn't available`}
            detail={t`It may have been deleted, or it belongs to someone else.`}
            onClose={close}
          />
        ) : failed || viewer.failed ? (
          <PageNotice
            title={t`This page couldn't load`}
            detail={t`Check your connection and try again.`}
            onRetry={() => {
              if (failed) void page.refetch();
              if (viewer.failed) viewer.retry();
            }}
            onClose={close}
          />
        ) : null
      }
      renameError={rename.isError ? t`Could not rename this page. Try again.` : null}
      onRename={
        rename.isPending || !data || !owned
          ? undefined
          : (title) => {
              if (pageId) rename.mutate({ pageId, title });
            }
      }
      composer={owned ? <div ref={setDockNode} /> : undefined}
      onReply={owned ? session.offerReply : undefined}
      share={
        data && owned ? (
          <SharePopover
            compact={compact}
            title={data.title}
            owner={data.owner}
            visibility={shownVisibility}
            shareUrl={link.data?.shareUrl ?? null}
            open={shareOpen}
            onOpenChange={setShareOpen}
            pending={visibility.isPending}
            error={
              visibility.isError ? t`Could not change who can view this page. Try again.` : null
            }
            onVisibilityChange={(next) => {
              if (pageId && next !== shownVisibility && !visibility.isPending) {
                visibility.mutate({ pageId, visibility: next });
              }
            }}
          />
        ) : null
      }
    />
  );
}
