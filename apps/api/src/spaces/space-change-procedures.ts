import type { SpaceChangeKind } from "@rakazo/contracts";

/**
 * Procedures that change what a Space change kind covers in the actor's Space, signalled once they
 * return. Work outside a request (runs starting and ending, a bot's own routine edits) signals
 * where it commits.
 */
const SPACE_CHANGE_PROCEDURES: Record<string, readonly SpaceChangeKind[]> = {
  "artifacts.create": ["artifacts"],
  "artifacts.remove": ["artifacts"],
  "routines.create": ["routines"],
  "routines.update": ["routines"],
  "routines.remove": ["routines"],
  "routines.testRun": ["runs"],
  // These can queue a run.
  "threads.sendWithRoutines": ["runs"],
  "threads.react": ["runs"],
  "threads.endCall": ["runs"],
  "threads.followUp": ["runs"],
  "skills.testRun": ["runs"],
  // Activity leaves out archived bots.
  "bots.restore": ["runs", "routines"],
  "bots.remove": ["runs", "routines"],
};

export function spaceChangesFor(path: readonly string[]): readonly SpaceChangeKind[] {
  return SPACE_CHANGE_PROCEDURES[path.join(".")] ?? [];
}
