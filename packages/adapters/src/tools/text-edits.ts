const MAX_EDITS = 50;

type TextEdit = { find: string; replace: string };

function parseTextEdits(value: unknown, argument: string): TextEdit[] | string {
  if (!Array.isArray(value) || value.length === 0) return `${argument} must be a non-empty list.`;
  if (value.length > MAX_EDITS) return `Send at most ${MAX_EDITS} edits at once.`;
  const edits: TextEdit[] = [];
  for (const [index, item] of value.entries()) {
    const edit = item as Partial<TextEdit> | null;
    if (typeof edit?.find !== "string" || typeof edit.replace !== "string") {
      return `Edit ${index + 1}: needs find and replace strings.`;
    }
    edits.push({ find: edit.find, replace: edit.replace });
  }
  return edits;
}

/**
 * `text` with the edits a call sent under `argument` applied, all or none: each `find` must occur
 * exactly once in the result of the edits before it. `where` names the text in an error, as in
 * "the page".
 */
export function editText(
  text: string,
  value: unknown,
  argument: string,
  where: string,
): { ok: true; text: string } | { ok: false; error: string } {
  const edits = parseTextEdits(value, argument);
  if (typeof edits === "string") return { ok: false, error: edits };
  let next = text;
  for (const [index, edit] of edits.entries()) {
    const label = `Edit ${index + 1}`;
    if (!edit.find) return { ok: false, error: `${label}: find is empty.` };
    const at = next.indexOf(edit.find);
    if (at === -1) return { ok: false, error: `${label}: find text was not found in ${where}.` };
    if (next.indexOf(edit.find, at + 1) !== -1) {
      return {
        ok: false,
        error: `${label}: find text occurs more than once; include more surrounding text.`,
      };
    }
    next = next.slice(0, at) + edit.replace + next.slice(at + edit.find.length);
  }
  return { ok: true, text: next };
}
