import type { Criterion, EvalCase, Evidence } from "../cases.js";

export const PAGES_FIXTURE_VERSION = "pages-v1";

const CREATE =
  "Make me a page called Signups dashboard that shows 120 signups this week and a churn rate of 2.1%.";

const check = (id: string, pass: boolean): Criterion => ({ id, pass });
const pages = (e: Evidence) => e.pages ?? [];
const listedInFinalStep = (e: Evidence) =>
  e.toolCalls.some(
    (call) => call.step === e.finalStep && call.name === "save_page" && call.args.list === true,
  );

/** One page, changed since it was made, now showing `value`. */
const updatedInPlace = (e: Evidence, value: string): Criterion[] => [
  check("one-page", pages(e).length === 1),
  check(
    "updated-in-place",
    pages(e).length === 1 && pages(e)[0]!.currentVersion > 1 && pages(e)[0]!.source.includes(value),
  ),
];

export const PAGES_EVAL_CASES: EvalCase[] = [
  {
    id: "update-page-after-clear",
    purpose:
      "Update the page the user names when the chat no longer holds its pageId, instead of making a second one.",
    steps: [
      { ask: CREATE },
      { clear: true },
      { ask: "Update my Signups dashboard: churn is now 1.9%." },
    ],
    grade: (e) => updatedInPlace(e, "1.9%"),
    observe: (e) => ({ listed: listedInFinalStep(e) }),
  },
  {
    id: "new-page-when-asked",
    purpose:
      "Make a new page when the user asks for one, leaving a similar existing page as it is.",
    steps: [
      { ask: CREATE },
      { clear: true },
      { ask: "Create a new page for EU signups: 40 signups this week and a churn rate of 3%." },
    ],
    grade: (e) => [
      check("two-pages", pages(e).length === 2),
      check("first-page-unchanged", pages(e)[0]?.currentVersion === 1),
    ],
    observe: (e) => ({ listed: listedInFinalStep(e) }),
  },
  {
    id: "routine-refreshes-page",
    purpose:
      "A routine refreshes the page its prompt names after the chat that made it was cleared.",
    routine: {
      name: "Dashboard refresh",
      prompt: "Update the Signups dashboard page so its churn rate reads 1.7%.",
    },
    steps: [{ ask: CREATE }, { clear: true }, { wakeRoutine: true }],
    grade: (e) => updatedInPlace(e, "1.7%"),
    observe: (e) => ({ listed: listedInFinalStep(e) }),
  },
];
