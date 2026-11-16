import {
  getPage,
  listPages,
  pinPage,
  removePage,
  renamePage,
  setPageVisibility,
} from "../pages.js";
import type { RouterContext } from "./context.js";

export function pagesRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const pageDeps = () => ({
    prisma: deps.prisma,
    secrets: deps.secrets,
    webOrigin: deps.env.webOrigin,
  });
  return {
    pages: {
      list: authed.pages.list.handler(({ context, input }) =>
        listPages(deps.prisma, context.actor, input),
      ),
      get: authed.pages.get.handler(({ context, input }) =>
        getPage(pageDeps(), context.actor, input),
      ),
      rename: authed.pages.rename.handler(({ context, input }) =>
        renamePage(deps.prisma, context.actor, input.pageId, input.title),
      ),
      setVisibility: authed.pages.setVisibility.handler(({ context, input }) =>
        setPageVisibility(
          pageDeps(),
          context.actor,
          input,
          context.signal ?? new AbortController().signal,
        ),
      ),
      pin: authed.pages.pin.handler(({ context, input }) =>
        pinPage(deps.prisma, context.actor, input.pageId, input.pinned),
      ),
      remove: authed.pages.remove.handler(({ context, input }) =>
        removePage(pageDeps(), context.actor, input.pageId),
      ),
    },
  };
}
