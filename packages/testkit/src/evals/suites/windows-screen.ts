import type { EvalCase } from "../cases.js";
import { createWindowsWorkbench, INSPECTION_BADGE } from "../fixtures/windows-workbench.js";

const orders = [
  { id: "loading-dock", summary: "Replace loading dock light", assignee: "Rowan" },
  { id: "warehouse-floor", summary: "Check aisle five sensor", assignee: "Mika" },
  { id: "safety-inspection", summary: "Inspect emergency exit sign", assignee: "Sam" },
  {
    id: "inspection-badge",
    summary: "Verify loading bay extinguisher",
    assignee: "Avery",
    badge: INSPECTION_BADGE,
  },
];

const cases: EvalCase[] = orders.map(({ id, summary, assignee, badge }) => ({
  id,
  purpose: badge ? "Read an image-only code and save an order" : "Save a work order",
  steps: [
    {
      ask: [
        `In the connected Windows app named workbench, create and save a new work order with Summary "${summary}" and Assignee "${assignee}".`,
        "The New work order button opens the form. Summary and Assignee are text fields, and Save work order is a button.",
        ...(badge
          ? [
              "Read the code printed in the Inspection badge on the form and enter it into Inspection code before saving.",
            ]
          : []),
        "Use as few desktop tool calls as you can while verifying the order was saved.",
      ].join(" "),
    },
  ],
  connections: [],
  shellUnneeded: true,
  fixtureData: { summary, assignee, badge },
  userComputer: () => ({
    ...createWindowsWorkbench(Boolean(badge)),
    allowWithoutApproval: true,
  }),
  grade({ userComputer }) {
    const record = userComputer?.saved;
    return [
      {
        id: "saved-correct-order",
        pass: record?.summary === summary && record?.assignee === assignee,
      },
      ...(badge
        ? [
            {
              id: "saved-the-visual-code",
              pass: record?.inspectionCode === badge && (userComputer?.screenshots ?? 0) > 0,
            },
          ]
        : []),
    ];
  },
}));

export const WINDOWS_SCREEN_SUITE = { cases, fixtureVersion: "windows-screen-v1" };
