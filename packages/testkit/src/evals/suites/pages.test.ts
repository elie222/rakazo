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

const page = (currentVersion: number, churn: string) => ({
  title: "Signups dashboard",
  currentVersion,
  source: `<Stat label="Churn" value="${churn}" />`,
});

describe("pages eval", () => {
  it("passes an update in place and fails a second page made instead", () => {
    expect(failed("update-page-after-clear", [page(2, "1.9%")])).toEqual([]);
    expect(failed("update-page-after-clear", [page(1, "2.1%"), page(1, "1.9%")])).toEqual([
      "one-page",
      "updated-in-place",
    ]);
  });

  it("passes a new page beside the untouched one and fails an edit of the old one", () => {
    expect(failed("new-page-when-asked", [page(1, "2.1%"), page(1, "3%")])).toEqual([]);
    expect(failed("new-page-when-asked", [page(2, "3%")])).toEqual([
      "two-pages",
      "first-page-unchanged",
    ]);
  });
});
