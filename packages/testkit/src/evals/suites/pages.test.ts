import { describe, expect, it } from "vitest";
import type { Evidence } from "../cases.js";
import { EMPTY_SETTINGS } from "../cases.js";
import { PAGES_EVAL_CASES } from "./pages.js";

type Pages = NonNullable<Evidence["pages"]>;

const failed = (id: string, pages: Pages) =>
  PAGES_EVAL_CASES.find((c) => c.id === id)!
    .grade({
      pages,
      text: "",
      files: {},
      records: [],
      notes: [],
      calls: [],
      routines: [],
      memory: "",
      approvalPending: false,
      pendingApproval: null,
      priorMemory: "",
      toolNames: [],
      toolCalls: [],
      finalStep: 3,
      settings: EMPTY_SETTINGS,
      settingsBefore: EMPTY_SETTINGS,
      messaging: { originThreadId: null, outbound: [] },
    })
    .filter((criterion) => !criterion.pass)
    .map((criterion) => criterion.id);

const page = (currentVersion: number, title = "Signups dashboard") => ({
  title,
  currentVersion,
});

describe("pages eval", () => {
  it("passes an update in place and fails a second page made instead", () => {
    expect(failed("update-page-after-clear", [page(2, "Weekly signups")])).toEqual([]);
    expect(failed("update-page-after-clear", [page(1), page(1, "Weekly signups")])).toEqual([
      "one-page",
      "updated-in-place",
    ]);
  });

  it("passes a new page beside the untouched one and fails an edit of the old one", () => {
    expect(failed("new-page-when-asked", [page(1), page(1, "EU signups")])).toEqual([]);
    expect(failed("new-page-when-asked", [page(2, "EU signups")])).toEqual([
      "two-pages",
      "first-page-unchanged",
      "new-page-created",
    ]);
  });

  it("rejects creating an unrelated page", () => {
    expect(failed("new-page-when-asked", [page(1), page(1, "Another dashboard")])).toEqual([
      "new-page-created",
    ]);
  });
});
