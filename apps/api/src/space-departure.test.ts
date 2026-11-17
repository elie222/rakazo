import { expect, it, vi } from "vitest";
import { afterSpaceDeparture } from "./space-departure.js";

it("tells the Space its routines and pages changed when a member departs", async () => {
  const publishSpaceChange = vi.fn();
  await afterSpaceDeparture(
    {
      prisma: {},
      sandbox: {},
      jobs: {},
      events: { notify: vi.fn(), publishSpaceChange },
    } as never,
    { spaceId: "space-1", userId: "user-1" },
    { events: [], heldControls: [], continuationRunIds: [], cancelledRuns: [] } as never,
  );
  expect(publishSpaceChange.mock.calls).toEqual([
    ["space-1", "routines"],
    ["space-1", "pages"],
  ]);
});
