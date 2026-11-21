import type { PageComment } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { pageCommentStatusLabel } from "./page-review.js";

it("shows a published result only when its revision number is available", () => {
  const comment: PageComment = {
    id: "comment",
    version: 1,
    section: "Overview",
    body: "Clarify the first paragraph",
    author: "Reviewer",
    mine: false,
    createdAt: "2026-11-19T00:00:00.000Z",
    resolvedAt: "2026-11-19T00:01:00.000Z",
    revision: { id: "request", status: "published", resultVersion: null },
  };
  expect(pageCommentStatusLabel(comment, 1)).toBe("Resolved");
  expect(
    pageCommentStatusLabel(
      { ...comment, revision: { id: "request", status: "published", resultVersion: 2 } },
      2,
    ),
  ).toBe("Published in revision 2");
});
