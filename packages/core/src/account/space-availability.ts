import type { SpaceAvailability } from "@rakazo/contracts";

/** True when removing an item takes it from more than this one space. */
export function reachesOtherSpaces(
  availability: SpaceAvailability | undefined,
  spaceCount: number,
): boolean {
  return (
    spaceCount > 1 && Boolean(availability?.allSpaces || (availability?.spaceIds.length ?? 0) > 1)
  );
}
