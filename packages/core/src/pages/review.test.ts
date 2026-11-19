import { expect, it } from "vitest";
import { pageCommentSubmission } from "./review.js";

it("reuses a lost comment submission only for the same normalized draft and revision", () => {
  const draft = { version: 1, section: "Summary", body: "Clarify the dates." };
  const first = pageCommentSubmission(draft);

  expect(pageCommentSubmission({ ...draft, body: ` ${draft.body}\n` }, first)).toBe(first);
  for (const change of [{ body: "Clarify the date." }, { section: "Timeline" }, { version: 2 }]) {
    expect(pageCommentSubmission({ ...draft, ...change }, first).submissionId).not.toBe(
      first.submissionId,
    );
  }
});
