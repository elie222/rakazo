import type { PageReview } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { pageReviewSections } from "../computers/artifact-sandbox.js";
import { pageCommentSubmission, pageReviewContent, pageSectionChoices } from "./review.js";

it("reuses a lost comment submission only for the same normalized draft and revision", () => {
  const draft = { version: 1, section: "Summary", body: "Clarify the dates." };
  const first = pageCommentSubmission(draft);

  expect(pageCommentSubmission({ ...draft, body: ` ${draft.body}\n` }, first)).toBe(first);
  for (const change of [
    { body: "Clarify the date." },
    { section: "Timeline" },
    { sectionOccurrence: 1 },
    { version: 2 },
  ]) {
    expect(pageCommentSubmission({ ...draft, ...change }, first).submissionId).not.toBe(
      first.submissionId,
    );
  }
});

it("uses only the authorized review and matching revision's headings", () => {
  const page: PageReview = {
    id: "page",
    title: "Review",
    code: "reviewed page",
    version: 1,
    currentVersion: 2,
    owner: false,
    canRequestRevision: false,
  };
  const sections = [{ section: "Earlier heading" }];
  expect(
    pageReviewContent({ page, showingDraft: false, reported: { version: 1, sections } }),
  ).toEqual({ code: page.code, sections });
  expect(
    pageReviewContent({ page, showingDraft: false, reported: { version: 2, sections } }),
  ).toEqual({ code: page.code, sections: [] });
  expect(pageReviewContent({ page, showingDraft: true, draftCode: "cached draft" })).toEqual({
    code: undefined,
    sections: [],
  });
  expect(
    pageReviewContent({ page: undefined, showingDraft: true, draftCode: "cached draft" }),
  ).toEqual({ code: undefined, sections: [] });
});

it("offers distinct choices for repeated headings and accepts labels from older runtimes", () => {
  const type = "rakazo-page:sections";
  const sections = ["Timeline", "Timeline"];
  const first = { section: "Timeline", sectionOccurrence: 0 };
  const second = { section: "Timeline", sectionOccurrence: 1 };
  const anchors = [first, second, first, { section: "Invalid", sectionOccurrence: -1 }];

  const choices = pageSectionChoices(pageReviewSections({ type, sections, anchors })!);
  expect(choices.map(({ label, anchor }) => ({ label, anchor }))).toEqual([
    { label: "Timeline (1)", anchor: first },
    { label: "Timeline (2)", anchor: second },
  ]);
  expect(choices[0]?.value).not.toBe(choices[1]?.value);
  expect(pageReviewSections({ type, sections })).toEqual([{ section: "Timeline" }]);
});
