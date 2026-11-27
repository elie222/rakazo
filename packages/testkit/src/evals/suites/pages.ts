import type { Criterion, EvalCase, Evidence } from "../cases.js";

export const PAGES_FIXTURE_VERSION = "pages-v2";

const ORIGINAL_TITLE = "Signups dashboard";
const UPDATED_TITLE = "Weekly signups";
const ROUTINE_TITLE = "Latest signups";
const NEW_TITLE = "EU signups";
const CREATE = `Make me a page called "${ORIGINAL_TITLE}" that shows 120 signups this week and a churn rate of 2.1%.`;

const check = (id: string, pass: boolean): Criterion => ({ id, pass });
const pages = (e: Evidence) => e.pages ?? [];
const listedInFinalStep = (e: Evidence) =>
  e.toolCalls.some(
    (call) => call.step === e.finalStep && call.name === "save_page" && call.args.list === true,
  );

const updatedInPlace = (e: Evidence, title: string): Criterion[] => [
  check("one-page", pages(e).length === 1),
  check(
    "updated-in-place",
    pages(e).length === 1 && pages(e)[0]!.currentVersion > 1 && pages(e)[0]!.title === title,
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
      { ask: `Rename my "${ORIGINAL_TITLE}" page to "${UPDATED_TITLE}".` },
    ],
    grade: (e) => updatedInPlace(e, UPDATED_TITLE),
    observe: (e) => ({ listed: listedInFinalStep(e) }),
  },
  {
    id: "new-page-when-asked",
    purpose:
      "Make a new page when the user asks for one, leaving a similar existing page as it is.",
    steps: [
      { ask: CREATE },
      { clear: true },
      {
        ask: `Create a new page titled "${NEW_TITLE}" for 40 signups this week and a churn rate of 3%.`,
      },
    ],
    grade: (e) => [
      check("two-pages", pages(e).length === 2),
      check(
        "first-page-unchanged",
        pages(e)[0]?.title === ORIGINAL_TITLE && pages(e)[0]?.currentVersion === 1,
      ),
      check("new-page-created", pages(e)[1]?.title === NEW_TITLE),
    ],
    observe: (e) => ({ listed: listedInFinalStep(e) }),
  },
  {
    id: "routine-refreshes-page",
    purpose:
      "A routine refreshes the page its prompt names after the chat that made it was cleared.",
    routine: {
      name: "Dashboard refresh",
      prompt: `Rename the "${ORIGINAL_TITLE}" page to "${ROUTINE_TITLE}".`,
    },
    steps: [{ ask: CREATE }, { clear: true }, { wakeRoutine: true }],
    grade: (e) => updatedInPlace(e, ROUTINE_TITLE),
    observe: (e) => ({ listed: listedInFinalStep(e) }),
  },
];
