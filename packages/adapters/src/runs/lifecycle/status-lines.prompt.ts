/** The person's message is cut to this length before it reaches the status model. */
const MAX_REQUEST_CHARS = 1_200;
/** A tool's technical description is cut to this length. */
const MAX_STEP_CHARS = 300;

/** How the status model is told to write the live status line. */
export const STATUS_LINE_INSTRUCTIONS = [
  "You write the live status line a chat assistant shows while it works on the person's request.",
  "Write in the language of the person's message inside <request>, whatever language these instructions or the examples use.",
  "Each status is two to five words, in the present continuous (for example “Checking availability”), says what is being done for the person, never technical details, file paths or commands.",
  "No final period, no quotes, no emoji, no markdown. Output only the status lines.",
].join(" ");

/** The opening status, before any step: about taking in the request, never claiming work. */
export function openingStatusPrompt(request: string) {
  return `${requestPrompt(request)}\n\nNothing has been done for this request yet. Write one status that says you are taking in what it asks about (for example “Looking into the plan pricing”). Never claim a search, check or comparison that has not happened.`;
}

/** A status for one step, from its technical description. Both texts arrive redacted. */
export function stepStatusPrompt(request: string, step: string) {
  return `${requestPrompt(request)}\n\n<step>\n${clip(step, MAX_STEP_CHARS)}\n</step>\n\nWrite one status for this step.`;
}

function requestPrompt(request: string) {
  return `<request>\n${clip(request, MAX_REQUEST_CHARS)}\n</request>`;
}

function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
