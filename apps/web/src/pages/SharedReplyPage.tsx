import { i18n } from "@lingui/core";
import { Trans } from "@lingui/react/macro";
import type { SharedReply } from "@rakazo/contracts";
import { isReplyShareToken, SHARED_REPLY_PATH_PREFIX } from "@rakazo/contracts";
import { Button, buttonVariants, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";

async function readSharedReply(token: string): Promise<SharedReply | null> {
  const response = await fetch(`${SHARED_REPLY_PATH_PREFIX}${token}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Shared reply returned ${response.status}`);
  return (await response.json()) as SharedReply;
}

/** One bot reply someone shared by link, for anyone holding it, signed in or not. */
export function SharedReplyPage() {
  return (
    <>
      {/* The link is the reply's only key, so no state of it belongs in search results. */}
      <meta name="robots" content="noindex, nofollow" />
      <SharedReplyBody />
    </>
  );
}

function SharedReplyBody() {
  const { token = "" } = useParams();
  const valid = isReplyShareToken(token);
  const shared = useQuery({
    queryKey: ["shared-reply", token],
    queryFn: () => readSharedReply(token),
    enabled: valid,
    retry: false,
  });

  if (!valid || shared.data === null) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-6 text-center">
        <div className="flex max-w-[360px] flex-col items-center gap-3">
          <img src="/favicon-32x32.png" alt="" className="size-8 rounded-full" />
          <h1 className="text-heading3 font-medium text-foreground">
            <Trans>This reply isn't available</Trans>
          </h1>
          <a href="/" className={`${buttonVariants({ variant: "outline", size: "sm" })} mt-1`}>
            <Trans>Open Rakazo</Trans>
          </a>
        </div>
      </main>
    );
  }
  if (shared.isError && !shared.data) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background px-6 text-center text-body-lg text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <p role="alert">
            <Trans>Couldn't load this reply. Try again.</Trans>
          </p>
          <Button variant="outline" size="sm" onClick={() => void shared.refetch()}>
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
  const { botName, text, sharedAt } = shared.data;
  return (
    <main className="min-h-dvh bg-background px-6 py-12">
      <article className="mx-auto flex max-w-[680px] flex-col gap-3">
        <header className="flex items-baseline justify-between gap-3">
          <h1 className="min-w-0 truncate text-body-lg font-medium text-foreground">{botName}</h1>
          <time dateTime={sharedAt} className="shrink-0 text-body text-muted-foreground">
            {new Intl.DateTimeFormat(i18n.locale || undefined, { dateStyle: "medium" }).format(
              new Date(sharedAt),
            )}
          </time>
        </header>
        {/* Plain text, never markdown: what the reply says is all the page shows. */}
        <p
          data-testid="shared-reply-text"
          dir="auto"
          className="whitespace-pre-wrap break-words text-body-lg text-foreground"
        >
          {text}
        </p>
      </article>
    </main>
  );
}
