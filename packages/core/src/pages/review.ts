import type { PageComment, PageReview } from "@rakazo/contracts";

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
