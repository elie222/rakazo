import type { MessageBlock } from "@rakazo/contracts";

/** A fenced block becomes a mention of itself, with its language if known. */
function describeCodeBlock(fence: string): string {
  const lang =
    fence
      .trim()
      .split(/\s+/)[0]
      ?.replace(/[^a-z0-9+#]/gi, "") ?? "";
  const spoken: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    py: "Python",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    json: "JSON",
    yml: "YAML",
    yaml: "YAML",
    sql: "SQL",
    rs: "Rust",
    go: "Go",
    swift: "Swift",
    diff: "diff",
  };
  const name = spoken[lang.toLowerCase()];
  return name ? `. (a ${name} code block) ` : ". (a code block) ";
}

/** `a/b/c/file.ts` → `file.ts`. A path's directories are for the eye. */
function shortenPaths(text: string): string {
  return text.replace(/(?:[\w.@-]+\/){1,}([\w.-]+\.\w{1,6})\b/g, "$1");
}

const ENDS_SENTENCE = /[.!?:;]\s*$/;

/**
 * Markdown (or any agent output) → a line a voice can read.
 *
 * Say the prose, name the artifacts, drop the syntax. Pure and synchronous
 * so it stays easy to tune against real transcripts.
 */
export function speakable(input: string): string {
  if (!input) return "";
  let text = input;

  text = text.replace(/```([^\n]*)\n[\s\S]*?(?:```|$)/g, (_m, fence: string) =>
    describeCodeBlock(fence),
  );
  text = text.replace(/~~~([^\n]*)\n[\s\S]*?(?:~~~|$)/g, (_m, fence: string) =>
    describeCodeBlock(fence),
  );

  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) =>
    alt ? `. (image: ${alt}) ` : ". (an image) ",
  );
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/<https?:\/\/[^>\s]+>/g, " a link ");
  text = text.replace(/\bhttps?:\/\/\S+/g, " a link ");

  text = text.replace(/^\s*\|?[\s:-]*\|[\s|:-]*$/gm, "");
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_m, row: string) =>
    row
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(", "),
  );

  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    code.length <= 40 ? code : " that snippet ",
  );

  text = text.replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, (_m, head: string) =>
    ENDS_SENTENCE.test(head) ? head : `${head.trim()}.`,
  );

  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, "");

  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");

  text = text.replace(/\[[ xX]\]\s*/g, "");

  text = shortenPaths(text);

  text = text.replace(
    /[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
    "",
  );

  text = text.replace(/\n{2,}/g, ". ");
  text = text.replace(/\n/g, ". ");

  text = text.replace(/\s+/g, " ");
  text = text.replace(/\s+([.,!?;:])/g, "$1");
  text = text.replace(/(?:\.\s*){2,}/g, ". ");
  text = text.replace(/,\s*\./g, ".");
  text = text.trim();

  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

const BOUNDARY =
  /(?<!\b(?:e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|No|approx))(?<![.\d])([.!?])(["')\]]*)\s+/g;

/**
 * Split speakable text into utterances a synthesizer can start on.
 * Short fragments are glued onto their neighbour so the voice keeps context.
 */
export function toUtterances(input: string, { minChars = 12, maxChars = 320 } = {}): string[] {
  const text = speakable(input);
  if (!text) return [];

  const MARK = "\u0000";
  const rough = text
    .replace(BOUNDARY, `$1$2${MARK}`)
    .split(MARK)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const piece of rough) {
    const parts = piece.length <= maxChars ? [piece] : splitLong(piece, maxChars);
    for (const part of parts) {
      const prev = out[out.length - 1];
      if (prev && (prev.length < minChars || part.length < minChars)) {
        out[out.length - 1] = `${prev} ${part}`;
      } else {
        out.push(part);
      }
    }
  }
  return out;
}

function splitLong(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const at = Math.max(
      window.lastIndexOf(", "),
      window.lastIndexOf("; "),
      window.lastIndexOf(" — "),
    );
    const cut = at > maxChars / 2 ? at + 1 : window.lastIndexOf(" ");
    if (cut <= 0) break;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** A tool-activity chip as a spoken progress line. Null when it is not worth hearing. */
export function narrateTool(toolName: string): string | null {
  const name = toolName.replace(/^mcp__[^_]+__/, "").trim();
  if (!name) return null;
  if (/^(auto-approved|error):/i.test(name)) return null;

  const bare = name.toLowerCase();
  const verbs: Array<[RegExp, string]> = [
    [/^(bash|shell|terminal|run_command|execute|computer_exec)$/, "running a command"],
    [/^(read|read_file|view|list_files)$/, "reading a file"],
    [/^(write|write_file|create_file)$/, "writing a file"],
    [/^(edit|apply_patch|str_replace|multiedit)$/, "editing a file"],
    [/^(grep|search|glob|find)$/, "searching"],
    [/^(web_?search|websearch)$/, "searching the web"],
    [/^(web_?fetch|fetch)$/, "reading a page"],
    [/^(screenshot|computer_observe)$/, "looking at the screen"],
    [/^(click|type_text|press_key|scroll|computer_batch|computer_act)$/, "using the computer"],
    [/^open_url$/, "opening a page"],
    [/^list_bots$/, "checking who's around"],
    [/^ask_bot$/, "asking a teammate"],
    [/^run_subagent$/, "starting a subagent"],
    [/^spawn_bot$/, "creating a bot"],
    [/^create_space$/, "creating a space"],
    [/^(archive_bot|delete_bot)$/, "archiving a bot"],
    [/^remember$/, "writing a memory"],
    [/^attach_file$/, "attaching a file"],
    [/^request_takeover$/, "asking you to take over"],
  ];
  for (const [pattern, phrase] of verbs) {
    if (pattern.test(bare)) return phrase;
  }
  const short = shortenPaths(name).slice(0, 40);
  return /^[\w .:/-]+$/.test(short) ? `running ${short}` : null;
}

export function speechFromBlocks(blocks: MessageBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "text" || block.kind === "progress" || block.kind === "meta")
        return block.text;
      if (block.kind === "ask") return block.text;
      if (block.kind === "computer") return block.text;
      if (block.kind === "subagent") {
        if (block.status === "running") return `${block.name} is working on ${block.task}`;
        if (block.status === "failed") return `${block.name} failed`;
        return block.result || `${block.name} finished`;
      }
      if (block.kind === "card") {
        return block.lines.map((line) => `${line.k}: ${line.v}`).join(". ");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const YES = /^(yes|yeah|yep|yup|ok|okay|sure|do it|go ahead|approve|confirmed|affirmative)\b/i;
const NO = /^(no|nope|nah|cancel|stop|don't|do not|reject|deny|negative)\b/i;

/** Consent must never be inferred from a sentence that merely contained "sure". */
export function spokenDecision(transcript: string): "yes" | "no" | null {
  const text = transcript.trim();
  if (!text) return null;
  if (YES.test(text) && text.split(/\s+/).length <= 6) return "yes";
  if (NO.test(text) && text.split(/\s+/).length <= 6) return "no";
  return null;
}
