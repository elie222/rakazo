import { ph, t } from "@lingui/core/macro";
import type { PageComment, PageVisibility } from "@rakazo/contracts";

export function pageSharingLabel(visibility?: PageVisibility) {
  if (visibility === "people") return t`Specific people`;
  if (visibility === "link") return t`Shared`;
  return undefined;
}

export function pageRevisionDataDisclosure() {
  return t`The page and selected comment are sent to draft a revision.`;
}

export function pageCommentStatusLabel(comment: PageComment, currentVersion: number) {
  const review = comment.revision;
  if (review?.status === "published" && typeof review.resultVersion === "number")
    return t`Published in revision ${ph({ version: review.resultVersion })}`;
  if (review?.status === "cancelled") return t`Request cancelled`;
  if (comment.version !== currentVersion) return t`Earlier revision`;
  if (review?.status === "pending") return t`Bot draft requested`;
  if (review?.status === "ready") return t`Draft ready`;
  if (review?.status === "failed") return t`Bot couldn't draft a revision`;
  return comment.resolvedAt ? t`Resolved` : null;
}
