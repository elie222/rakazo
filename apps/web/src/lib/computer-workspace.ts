import {
  type ComputerCommand,
  ComputerCommandSchema,
  foldComputerCommands,
  type ProductEvent,
} from "@rakazo/contracts";

type Listener = (botId: string, command: ComputerCommand) => void;

const listeners = new Set<Listener>();

/** Thread subscriptions forward bot shell commands to any open terminal. */
export function publishComputerCommand(event: ProductEvent) {
  if (event.type !== "computer.command") return;
  const parsed = ComputerCommandSchema.safeParse(event.payload);
  if (!parsed.success) return;
  for (const listener of listeners) listener(event.botId, parsed.data);
}

export function subscribeComputerCommands(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function mergeComputerCommand(commands: ComputerCommand[], next: ComputerCommand) {
  return foldComputerCommands([...commands, next]);
}

/** Localized one-line descriptions of the bot's file and app actions. */
export type ComputerActionLabels = Record<
  Exclude<ComputerCommand["kind"], "shell">,
  (target: string) => string
>;

const ACTION_GLYPHS: Record<keyof ComputerActionLabels, string> = {
  write_file: "✎",
  attach_file: "✎",
  open_path: "↗",
  launch_app: "↗",
};

/**
 * Render one Activity entry as terminal text. Shell commands get a bold prompt line, their
 * output, and a failed exit code; file and app actions get one line and, if they failed, the
 * error.
 */
export function formatComputerCommand(command: ComputerCommand, labels: ComputerActionLabels) {
  const lines: string[] = [];
  if (command.kind === "shell") {
    lines.push(`\x1b[1m$ ${command.command}\x1b[0m`);
    if (command.output) lines.push(command.output.replace(/\n$/, ""));
    if (command.status === "done" && command.exitCode) {
      lines.push(`\x1b[2m[exit ${command.exitCode}]\x1b[0m`);
    }
  } else {
    const size = command.bytes === undefined ? "" : ` \x1b[2m(${formatSize(command.bytes)})\x1b[0m`;
    lines.push(
      `\x1b[2m${ACTION_GLYPHS[command.kind]}\x1b[0m ${labels[command.kind](command.command)}${size}`,
    );
    if (command.exitCode) lines.push(`\x1b[2m${command.output}\x1b[0m`);
  }
  return `${lines.join("\n").replace(/\r?\n/g, "\r\n")}\r\n`;
}

export type ComputerFileEntry = { path: string; kind: "file" | "dir"; size: number };

export function sortEntries(entries: ComputerFileEntry[]) {
  return [...entries].sort(
    (a, b) =>
      Number(b.kind === "dir") - Number(a.kind === "dir") ||
      basename(a.path).localeCompare(basename(b.path)),
  );
}

export function parentPath(path: string) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

export function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
