import { Trans } from "@lingui/react/macro";
import { PageIcon } from "@rakazo/chat-ui/web";
import { uniquePages } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useOpenPage } from "../../lib/pages";
import { useSpaceQueries } from "../../lib/query";
import { SidebarShelf } from "./sidebar-shelf";

const PAGE_SIZE = 20;

/**
 * Every page shared with the Space, anyone's, folded at the bottom of the sidebar. Absent until
 * there is one, and read again whenever a page's sharing changes.
 */
export function SharedPages({ showSpaceSearch }: { showSpaceSearch: boolean }) {
  const queries = useSpaceQueries();
  const openPage = useOpenPage();
  const pages = useInfiniteQuery(
    queries.pages.list.infiniteOptions({
      input: (cursor: string | null) => ({
        scope: "space" as const,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
    }),
  );
  const items = uniquePages((pages.data?.pages ?? []).flatMap((read) => read.items));
  if (items.length === 0 || showSpaceSearch) return null;
  return (
    <SidebarShelf title={<Trans>Shared pages</Trans>} count={items.length}>
      {items.map((page) => (
        <button
          key={page.id}
          type="button"
          onClick={() => openPage(page.id)}
          className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-start outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PageIcon className="h-5 w-4 shrink-0 text-foreground/60" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body text-foreground/75" dir="auto">
              {page.title}
            </span>
            {page.ownerName ? (
              <span className="truncate text-label text-faint-foreground" dir="auto">
                {page.ownerName}
              </span>
            ) : null}
          </span>
        </button>
      ))}
      {pages.hasNextPage ? (
        <Button
          variant="ghost"
          size="xs"
          className="self-start"
          disabled={pages.isFetchingNextPage}
          onClick={() => void pages.fetchNextPage()}
        >
          <Trans>Show more</Trans>
        </Button>
      ) : null}
    </SidebarShelf>
  );
}
