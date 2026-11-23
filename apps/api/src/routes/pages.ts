import { AI_CONSENT_REQUIRED } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { aiConsentStatus } from "../account/ai-consent.js";
import {
  addPageComment,
  getPageGrants,
  getPageReview,
  grantPage,
  listPageReviews,
  pageComments,
  resolvePageComment,
  revokePage,
} from "../content/page-collaboration.js";
import { askPageRevision, getPageDraft, publishPageDraft } from "../content/page-revisions.js";
import {
  getPage,
  listPages,
  pinPage,
  removePage,
  renamePage,
  setPageVisibility,
} from "../content/pages.js";
import type { RouterContext } from "./context.js";

export function pagesRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const pageDeps = () => ({
    prisma: deps.prisma,
    secrets: deps.secrets,
    webOrigin: deps.env.webOrigin,
    events: deps.events,
  });
  return {
    pageReviews: {
      list: authed.pageReviews.list.handler(({ context, input }) =>
        listPageReviews(deps.prisma, context.actor, input.cursor),
      ),
      get: authed.pageReviews.get.handler(({ context, input }) =>
        getPageReview(deps.prisma, context.actor, input),
      ),
      grants: authed.pageReviews.grants.handler(({ context, input }) =>
        getPageGrants(deps.prisma, context.actor, input.pageId),
      ),
      grant: authed.pageReviews.grant.handler(({ context, input }) =>
        grantPage(deps, context.actor, input),
      ),
      revoke: authed.pageReviews.revoke.handler(({ context, input }) =>
        revokePage(deps, context.actor, input),
      ),
      comments: authed.pageReviews.comments.handler(({ context, input }) =>
        pageComments(deps.prisma, context.actor, input),
      ),
      comment: authed.pageReviews.comment.handler(({ context, input }) =>
        addPageComment(deps, context.actor, input),
      ),
      resolve: authed.pageReviews.resolve.handler(({ context, input }) =>
        resolvePageComment(deps, context.actor, input),
      ),
      askRevision: authed.pageReviews.askRevision.handler(async ({ context, input }) => {
        if (!deps.pageRevisions)
          throw new ClientError("SERVICE_UNAVAILABLE", "Page revisions are unavailable");
        const consent = await aiConsentStatus(deps, context.actor, { pageId: input.pageId });
        if (consent.recipients.some((recipient) => !recipient.allowed))
          throw new ClientError("FORBIDDEN", AI_CONSENT_REQUIRED, "AI_CONSENT_REQUIRED");
        return askPageRevision({ ...deps, start: deps.pageRevisions.start }, context.actor, input);
      }),
      draft: authed.pageReviews.draft.handler(({ context, input }) =>
        getPageDraft(deps.prisma, context.actor, input),
      ),
      publish: authed.pageReviews.publish.handler(({ context, input }) =>
        publishPageDraft(deps, context.actor, input),
      ),
    },
    pages: {
      list: authed.pages.list.handler(({ context, input }) =>
        listPages(deps.prisma, context.actor, input),
      ),
      get: authed.pages.get.handler(({ context, input }) =>
        getPage(pageDeps(), context.actor, input),
      ),
      rename: authed.pages.rename.handler(({ context, input }) =>
        renamePage(deps.prisma, context.actor, input.pageId, input.title, deps.events),
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
