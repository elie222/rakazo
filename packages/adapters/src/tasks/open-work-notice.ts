import { bestEffort } from "@rakazo/logging";
import type { RoutineNoticeDeps } from "../routines/routine-notice.js";
import { writeChatRow } from "../routines/routine-notice.js";

/**
 * The small row the bot leaves in the chat when it adds to its open work: a system message with
 * one `open_work_event` block holding the item's title, never its notes. Never throws: the item
 * is already saved, so a failure is only logged.
 */
export async function postOpenWorkNotice(
  deps: RoutineNoticeDeps,
  input: { spaceId: string; threadId: string; botId: string; itemId: string; title: string },
): Promise<void> {
  await bestEffort(
    "open work notice",
    writeChatRow(deps, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      block: { kind: "open_work_event", itemId: input.itemId, title: input.title.slice(0, 200) },
    }),
  );
}
