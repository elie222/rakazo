import type { PageComment, PageReview } from "@rakazo/contracts";
import { newClientId } from "../primitives/client-id.js";

type PageCommentDraft = Pick<PageComment, "version" | "section" | "body">;
export type PageCommentSubmission = PageCommentDraft & { submissionId: string };

export function pageCommentSubmission(
  draft: PageCommentDraft,
  previous?: PageCommentSubmission,
): PageCommentSubmission {
  const { version } = draft;
  const section = draft.section.trim();
  const body = draft.body.trim();
  if (previous?.version === version && previous.section === section && previous.body === body)
    return previous;
  return { version, section, body, submissionId: newClientId() };
}

export function pageCommentActions(page: PageReview, comment: PageComment) {
  const canResolve = page.owner || comment.mine;
  const revision = comment.revision;
  const canRevise =
    page.canRequestRevision &&
    comment.version === page.version &&
    page.version === page.currentVersion &&
    !comment.resolvedAt;
  return {
    canResolve,
    canAsk:
      canResolve &&
      canRevise &&
      (!revision || revision.status === "failed" || revision.status === "cancelled"),
    draftId: page.owner && canRevise && revision?.status === "ready" ? revision.id : null,
  };
}

export function canPostPageComment(sections: readonly string[], section: string, body: string) {
  return Boolean(body.trim() && (sections.length ? sections.includes(section) : section.trim()));
}
