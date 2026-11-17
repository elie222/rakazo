import type { SpaceChangeKind } from "@rakazo/contracts";

/**
 * Procedures that change what a Space change kind covers in the actor's Space, signalled once they
 * return. Work outside a request (runs starting and ending, a bot's own routine edits) signals
 * where it commits.
 */
const SPACE_CHANGE_PROCEDURES: Record<string, readonly SpaceChangeKind[]> = {
  "routines.create": ["routines"],
  "routines.update": ["routines"],
  "routines.remove": ["routines"],
  "routines.testRun": ["runs"],
  // What a page is shared with changes who can list and open it.
  "pages.setVisibility": ["pages"],
  "pages.rename": ["pages"],
  "pages.remove": ["pages"],
  // These can queue a run.
  "threads.sendWithRoutines": ["runs"],
  "threads.react": ["runs"],
  "threads.endCall": ["runs"],
  "threads.followUp": ["runs"],
  "skills.testRun": ["runs"],
  // Activity leaves out archived bots.
  "bots.restore": ["runs", "routines"],
  "bots.remove": ["runs", "routines", "pages"],
  // A removed bot or chat takes its pages, shared ones included.
  "groups.remove": ["pages"],
};

export function spaceChangesFor(path: readonly string[]): readonly SpaceChangeKind[] {
  return SPACE_CHANGE_PROCEDURES[path.join(".")] ?? [];
}
