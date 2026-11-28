import { Trans } from "@lingui/react/macro";
import type { PageImageSource, SharedPage } from "@rakazo/contracts";
import { pageShareTokenFromSlug, SHARED_PAGE_PATH_PREFIX } from "@rakazo/contracts";
import { Button, buttonVariants, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { PublicPageShell } from "../components/pages/PublicPageShell";
import { usePageContent, usePageDocument } from "../lib/pages/pages";

async function readSharedPage(token: string): Promise<SharedPage | null> {
  const response = await fetch(`${SHARED_PAGE_PATH_PREFIX}${token}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Shared page returned ${response.status}`);
  return (await response.json()) as SharedPage;
}

async function readSharedPageImage(token: string, imageId: string): Promise<PageImageSource> {
  const response = await fetch(
    `${SHARED_PAGE_PATH_PREFIX}${token}/images/${encodeURIComponent(imageId)}`,
    { credentials: "omit", referrerPolicy: "no-referrer" },
  );
  if (!response.ok)
    throw Object.assign(new Error(`Shared page image returned ${response.status}`), {
      status: response.status,
    });
  return (await response.json()) as PageImageSource;
}

/** A page someone shared by link, for anyone holding it, signed in or not. */
export function SharedPagePage() {
  return (
    <>
      {/* The link is the page's only key, so no state of it belongs in search results. */}
      <meta name="robots" content="noindex, nofollow" />
      <SharedPageBody />
    </>
  );
}

function SharedPageBody() {
  const { slugToken = "" } = useParams();
  const token = pageShareTokenFromSlug(slugToken);
  const shared = useQuery({
    queryKey: ["shared-page", token],
    queryFn: () => readSharedPage(token!),
    enabled: token !== null,
    retry: false,
  });
  const content = usePageContent(shared.data, (imageId) => ({
    queryKey: ["shared-page", token, "image", imageId],
    queryFn: () => readSharedPageImage(token!, imageId),
  }));
  const viewer = usePageDocument(content);
  const title = shared.data?.title;
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  if (token === null || shared.data === null) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-6 text-center">
        <div className="flex max-w-[360px] flex-col items-center gap-3">
          <img src="/favicon-32x32.png" alt="" className="size-8 rounded-full" />
          <h1 className="text-heading3 font-medium text-foreground">
            <Trans>This page isn't available</Trans>
          </h1>
          <p className="text-body text-muted-foreground">
            <Trans>The owner may have turned off its link or deleted it.</Trans>
          </p>
          <a href="/" className={`${buttonVariants({ variant: "outline", size: "sm" })} mt-1`}>
            <Trans>Open Rakazo</Trans>
          </a>
        </div>
      </main>
    );
  }
  // Busy or unreachable is not gone; a failed refresh keeps the page being read.
  const failed = shared.isError && !shared.data;
  if (failed || viewer.failed) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background px-6 text-center text-body-lg text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <p role="alert">
            <Trans>Couldn't load this page. Try again.</Trans>
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (failed) void shared.refetch();
              if (viewer.failed) viewer.retry();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      </div>
    );
  }
  if (!shared.data) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background text-muted-foreground">
        <Spinner />
      </div>
    );
  }
  return <PublicPageShell title={shared.data.title} document={viewer.document} />;
}
