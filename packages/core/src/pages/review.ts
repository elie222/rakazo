import type { PageComment, PageImages, PageReview, PageSectionAnchor } from "@rakazo/contracts";
import { newClientId } from "../primitives/client-id.js";

type PageCommentDraft = Pick<PageComment, "version" | "body"> & PageSectionAnchor;
export type PageCommentSubmission = PageCommentDraft & { submissionId: string };
export type PageReviewSections = { version: number; sections: PageSectionAnchor[] };
export type PageShown = { code: string; images: PageImages; version: number };

export function pageReviewContent({
  page,
  showingDraft,
  draft,
  reported,
}: {
  page: PageReview | undefined;
  showingDraft: boolean;
  draft?: { code: string; images: PageImages };
  reported?: PageReviewSections;
}): { shown: PageShown | undefined; sections: PageSectionAnchor[] } {
  if (!page) return { shown: undefined, sections: [] };
  if (showingDraft)
    return {
      shown: page.owner && draft ? { ...draft, version: page.version } : undefined,
      sections: [],
    };
  return {
    shown: { code: page.code, images: page.images, version: page.version },
    sections: reported?.version === page.version ? reported.sections : [],
  };
}

export function pageCommentSubmission(
  draft: PageCommentDraft,
  previous?: PageCommentSubmission,
): PageCommentSubmission {
  const { version, sectionOccurrence } = draft;
  const section = draft.section.trim();
  const body = draft.body.trim();
  if (
    previous?.version === version &&
    previous.section === section &&
    previous.sectionOccurrence === sectionOccurrence &&
    previous.body === body
  )
    return previous;
  return { version, section, sectionOccurrence, body, submissionId: newClientId() };
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

export function pageSectionChoices(sections: readonly PageSectionAnchor[]) {
  const repeated = new Set(
    sections.filter(({ sectionOccurrence }) => (sectionOccurrence ?? 0) > 0).map((s) => s.section),
  );
  return sections.map((anchor) => ({
    value: JSON.stringify([anchor.section, anchor.sectionOccurrence]),
    label: repeated.has(anchor.section)
      ? `${anchor.section} (${(anchor.sectionOccurrence ?? 0) + 1})`
      : anchor.section,
    anchor,
  }));
}
