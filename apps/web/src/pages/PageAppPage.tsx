import { Trans, useLingui } from "@lingui/react/macro";
import {
  PAGE_WEB_APP_SPACE_PARAM,
  pageWebAppIconUrl,
  pageWebAppManifestUrl,
} from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { PageDrawing, usePageDrawing } from "../components/pages/PageDrawing";
import { PageNotice } from "../components/pages/PageNotice";
import { usePageStateSaver } from "../lib/pages/page-state";
import {
  askPageBot,
  pageAskChat,
  usePageDocument,
  useReviewedPageContent,
} from "../lib/pages/pages";
import { followStream } from "../lib/query/follow-stream";
import { useSpaceQueries } from "../lib/query/query";
import { spaceChanged } from "../lib/query/space-changes";
import { SpaceRpcProvider, useSpaceRpc } from "../lib/query/space-rpc";
import { errorCode } from "../lib/query/user-error";
import { useEventListener } from "../lib/use-event-listener";

type InstallPrompt = Event & { prompt(): Promise<unknown> };

declare global {
  interface WindowEventMap {
    beforeinstallprompt: InstallPrompt;
  }
}

/** One of the user's pages by itself in the whole window, which a browser can install as an app. */
export default function PageAppPage() {
  const { pageId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const spaceId = searchParams.get(PAGE_WEB_APP_SPACE_PARAM);
  return (
    <SpaceRpcProvider spaceId={spaceId ?? undefined}>
      <PageApp key={`${pageId}:${spaceId ?? ""}`} pageId={pageId} spaceId={spaceId} />
    </SpaceRpcProvider>
  );
}

function PageApp({ pageId, spaceId }: { pageId: string; spaceId: string | null }) {
  const { t } = useLingui();
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
  const read = queries.pages.get.queryOptions({ input: { pageId } });
  const page = useQuery({ ...read, refetchOnWindowFocus: "always" });
  const data = page.data;
  const savedState = data?.readerState;
  const rpc = useSpaceRpc();
  // Questions still waiting end when the page closes.
  const asking = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    asking.current = controller;
    return () => controller.abort();
  }, []);
  const askChat = data?.abilities.includes("ask") === true && pageAskChat(data) !== null;
  const viewer = usePageDocument(
    useReviewedPageContent(pageId, data),
    "card",
    false,
    0,
    false,
    undefined,
    savedState,
    askChat,
  );
  const readerState = usePageStateSaver(pageId, read.queryKey);
  const drawing = usePageDrawing(data ? viewer.document : null);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  useEventListener(window, "beforeinstallprompt", (event) => {
    event.preventDefault();
    setInstallPrompt(event);
  });
  usePageAppHead(pageId, spaceId, data?.title);

  // Busy or unreachable keeps the page being read; deleted or no longer theirs does not.
  const failed = page.isError && data === undefined;
  const code = errorCode(page.error);
  const notice =
    page.isError && (code === "NOT_FOUND" || code === "FORBIDDEN") ? (
      <PageNotice
        title={t`This page isn't available`}
        detail={t`It may have been deleted, or it belongs to someone else.`}
      />
    ) : failed || viewer.failed ? (
      <PageNotice
        title={t`This page couldn't load`}
        detail={t`Check your connection and try again.`}
        onRetry={() => {
          if (failed) void page.refetch();
          if (viewer.failed) viewer.retry();
        }}
      />
    ) : null;
  return (
    <main className="relative h-dvh bg-card text-foreground">
      {notice ?? (
        <PageDrawing
          drawing={drawing}
          title={data?.title ?? ""}
          onSaveState={savedState ? readerState.save : undefined}
          onAsk={
            data && askChat
              ? (text) => askPageBot(rpc, data, text, asking.current?.signal)
              : undefined
          }
        />
      )}
      {readerState.failed ? (
        <p
          role="alert"
          className="fixed inset-x-3 bottom-3 mx-auto w-fit rounded-full bg-card px-3 py-1.5 text-label text-destructive ring-[0.5px] ring-border"
        >
          {t`Your changes aren't saved. Check your connection.`}
        </p>
      ) : null}
      {installPrompt && !notice ? (
        <Button
          size="sm"
          variant="outline"
          className="fixed top-3 end-3 bg-card"
          onClick={() => {
            setInstallPrompt(null);
            void installPrompt.prompt();
          }}
        >
          <Trans>Install</Trans>
        </Button>
      ) : null}
    </main>
  );
}

/**
 * Points the document at this page's own manifest and icons in place of Rakazo's, so the browser
 * installs the page rather than the whole app, and puts them back when the page closes.
 */
function usePageAppHead(pageId: string, spaceId: string | null, title: string | undefined) {
  useEffect(() => {
    const restore = [
      setHead("link", "manifest", "href", pageWebAppManifestUrl(pageId, spaceId), {
        crossorigin: "use-credentials",
      }),
      setHead("link", "apple-touch-icon", "href", pageWebAppIconUrl(pageId, "180", spaceId)),
    ];
    return () => {
      for (const undo of restore) undo();
    };
  }, [pageId, spaceId]);
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    const undo = setHead("meta", "apple-mobile-web-app-title", "content", title);
    return () => {
      document.title = previous;
      undo();
    };
  }, [title]);
}

function setHead(
  tag: "link" | "meta",
  name: string,
  attribute: "href" | "content",
  value: string,
  extra: Record<string, string> = {},
): () => void {
  const selector = tag === "link" ? `link[rel="${name}"]` : `meta[name="${name}"]`;
  const existing = document.head.querySelector(selector);
  const element = existing ?? document.head.appendChild(document.createElement(tag));
  const before = [attribute, ...Object.keys(extra)].map(
    (key) => [key, element.getAttribute(key)] as const,
  );
  if (!existing) element.setAttribute(tag === "link" ? "rel" : "name", name);
  element.setAttribute(attribute, value);
  for (const [key, extraValue] of Object.entries(extra)) element.setAttribute(key, extraValue);
  return () => {
    if (!existing) {
      element.remove();
      return;
    }
    for (const [key, previous] of before) {
      if (previous === null) element.removeAttribute(key);
      else element.setAttribute(key, previous);
    }
  };
}
