const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PUNCTUATED_OPTION = /^(?:([A-Za-z])|([1-9]\d*))[.):]\s+(.+)$/;
const LOOSE_OPTION = /^([A-Da-d])\s+(.+)$/;

export type AskOption = { id: string; letter: string; label: string };

export function parseAskOptions(input: {
  text: string;
  detail?: string;
  actions?: Array<{ id: string; label: string }>;
}): { question: string; options: AskOption[] } {
  const textLines = splitLines(input.text);
  if (input.actions?.length) {
    return {
      question: questionWithExplicitActions(textLines) || "Need a decision",
      options: input.actions.map((action, index) => ({
        id: action.id,
        letter: letterAt(index),
        label: action.label.trim(),
      })),
    };
  }

  const options: AskOption[] = [];
  const questionLines: string[] = [];
  const lines = [
    ...textLines.map((line) => ({ line, belongsToQuestion: true })),
    ...splitLines(input.detail).map((line) => ({ line, belongsToQuestion: false })),
  ];
  for (const { line, belongsToQuestion } of lines) {
    const fromQuestion = questionLines.length > 0 || options.length > 0;
    const punctuated = line.match(PUNCTUATED_OPTION);
    const loose = fromQuestion ? line.match(LOOSE_OPTION) : null;
    const match = punctuated ?? loose;
    const label = match ? (punctuated ? match[3] : match[2])?.trim() : "";
    if (label) {
      options.push({
        id: letterAt(options.length),
        letter: letterAt(options.length),
        label,
      });
      continue;
    }
    if (!options.length && belongsToQuestion) questionLines.push(line);
  }

  return {
    question: questionLines.join(" ").trim() || textLines[0] || "Need a decision",
    options,
  };
}

export function matchingAskOption(
  options: readonly AskOption[],
  answer: string | undefined,
): AskOption | undefined {
  if (!answer) return undefined;
  const needle = answer
    .trim()
    .toLowerCase()
    .replace(/^([a-z]|[1-9]\d*)[.):]\s*/, "$1 ")
    .trim();
  return options.find(
    (option) =>
      option.id.toLowerCase() === needle ||
      option.label.toLowerCase() === needle ||
      option.letter.toLowerCase() === needle ||
      `${option.letter} ${option.label}`.toLowerCase() === needle,
  );
}

function letterAt(index: number): string {
  return LETTERS[index] ?? String(index + 1);
}

function splitLines(value: string | undefined): string[] {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function questionWithExplicitActions(lines: string[]): string {
  const [first, ...rest] = lines;
  if (!first) return "";
  return [
    first,
    ...rest.filter((line) => !PUNCTUATED_OPTION.test(line) && !LOOSE_OPTION.test(line)),
  ].join(" ");
}
