import { endsWholeCharacter, fitTextPage, SERIALIZED_PAGE_LIMIT } from "./text-page.js";

const PROMPT_PREVIEW_CHARS = 200;
const SHORTENED_NOTE =
  "promptLength marks a prompt cut to a preview or left out, and a watch's lastCheck is left out. Read a prompt in full with schedule_list and its routineId.";

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
 * The list with long prompts as previews, or its routines only named when that is still too long,
 * so one result holds every routine. Those past what fits even then are counted in `notListed`.
 * A list of short prompts that fits is returned as it is.
 */
export function summarizeRoutineList<Routine extends ListedRoutine>(list: RoutineList<Routine>) {
  if (!list.routines.some(isLong) && fits(list)) return list;
  const note = list.note ? `${list.note} ${SHORTENED_NOTE}` : SHORTENED_NOTE;
  const previews = { note, routines: list.routines.map(previewed) };
  if (fits(previews)) return previews;
  const names = list.routines.map(named);
  let shown = names.length;
  const listed = () => ({
    note,
    routines: names.slice(0, shown),
    ...(shown < names.length ? { notListed: names.length - shown } : {}),
  });
  while (shown > 0 && !fits(listed())) shown -= 1;
  return listed();
}

/** The list whole when it fits one result; otherwise its summary. */
export function fitRoutineList<Routine extends ListedRoutine>(list: RoutineList<Routine>) {
  return fits(list) ? list : summarizeRoutineList(list);
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
  return (
    fitTextPage(routine.prompt, offset, (prompt, paging) => ({
      ...list,
      routines: [
        {
          ...routine,
          prompt,
          promptLength: paging.length,
          promptOffset: offset,
          promptNextOffset: paging.nextOffset,
        },
      ],
    })) ?? { error: "This routine's other details leave no room to read its prompt." }
  );
}
