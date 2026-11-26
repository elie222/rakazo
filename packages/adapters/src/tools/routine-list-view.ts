import { endsWholeCharacter, fitTextPage, SERIALIZED_PAGE_LIMIT } from "./text-page.js";

const PROMPT_PREVIEW_CHARS = 200;
const SHORTENED_NOTE =
  "promptLength marks a prompt cut to a preview or left out, and a watch's lastCheck is left out. Read a prompt in full with schedule_list and its routineId. nextRoutineOffset continues a longer list as schedule_list's routineOffset.";

type ListedRoutine = {
  routineId: string;
  name: string;
  prompt: string;
  active: boolean;
  lastCheck?: unknown;
  inThisChat?: boolean;
};
type RoutineList<Routine> = { note?: string; routines: Routine[] };

const fits = (list: unknown) => JSON.stringify(list).length <= SERIALIZED_PAGE_LIMIT;
const isLong = (routine: ListedRoutine) => routine.prompt.length > PROMPT_PREVIEW_CHARS;

/** A long prompt as its opening and length; a watch's last reading, which can be long, left out. */
function previewed<Routine extends ListedRoutine>({ lastCheck: _lastCheck, ...routine }: Routine) {
  if (!isLong(routine)) return routine;
  const end = endsWholeCharacter(routine.prompt, PROMPT_PREVIEW_CHARS)
    ? PROMPT_PREVIEW_CHARS
    : PROMPT_PREVIEW_CHARS - 1;
  return {
    ...routine,
    prompt: routine.prompt.slice(0, end),
    promptLength: routine.prompt.length,
  };
}

/** What names a routine and reads it, for a list too long to describe each one. */
const named = (routine: ListedRoutine) => ({
  routineId: routine.routineId,
  name: routine.name,
  active: routine.active,
  promptLength: routine.prompt.length,
  ...(routine.inThisChat === undefined ? {} : { inThisChat: routine.inThisChat }),
});

/**
 * The list with long prompts as previews, or its routines only named when that is still too long.
 * A named list longer than one result continues from `nextRoutineOffset`. A list of short prompts
 * that fits is returned as it is.
 */
export function summarizeRoutineList<Routine extends ListedRoutine>(
  list: RoutineList<Routine>,
  offset = 0,
) {
  if (offset === 0 && !list.routines.some(isLong) && fits(list)) return list;
  const note = list.note ? `${list.note} ${SHORTENED_NOTE}` : SHORTENED_NOTE;
  const previews = { note, routines: list.routines.map(previewed) };
  if (offset === 0 && fits(previews)) return previews;
  const page = (end: number) => ({
    note,
    routines: list.routines.slice(offset, end).map(named),
    ...(end < list.routines.length ? { nextRoutineOffset: end } : {}),
  });
  // Serialized length only grows with the page, so the largest fitting end is a search.
  let low = offset + 1;
  let high = list.routines.length;
  let end = low;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(page(mid))) {
      end = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return page(end);
}

/** The list whole when it fits one result; otherwise its summary, from `offset` when it continues. */
export function fitRoutineList<Routine extends ListedRoutine>(
  list: RoutineList<Routine>,
  offset = 0,
) {
  return offset === 0 && fits(list) ? list : summarizeRoutineList(list, offset);
}

/** A list of the one routine asked for: its prompt whole when it fits, or the page from `offset`. */
export function readRoutine<Routine extends ListedRoutine>(
  list: RoutineList<Routine>,
  offset: number,
) {
  const found = list.routines[0];
  if (!found) return { error: "Schedule not found." };
  if (offset === 0 && fits(list)) return list;
  if (offset > 0 && offset >= found.prompt.length)
    return { error: "promptOffset is past the end of the prompt." };
  const { lastCheck: _lastCheck, ...routine } = found;
  const page = (shown: object) =>
    fitTextPage(found.prompt, offset, (prompt, paging) => ({
      ...list,
      routines: [
        {
          ...shown,
          prompt,
          promptLength: paging.length,
          promptOffset: offset,
          promptNextOffset: paging.nextOffset,
        },
      ],
    }));
  // Details too long to leave the prompt any room give way to it.
  return page(routine) ?? page(named(found)) ?? { error: "This routine is too long to read." };
}
