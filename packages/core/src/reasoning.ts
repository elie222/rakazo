import type { ReasoningStep } from "@rakazo/contracts";

export const PENDING_USER_MESSAGE_PREFIX = "pending:";

export function isPendingUserMessageId(id: string): boolean {
  return id.startsWith(PENDING_USER_MESSAGE_PREFIX);
}

export function createPendingUserMessageId(): string {
  return `${PENDING_USER_MESSAGE_PREFIX}${crypto.randomUUID()}`;
}

export function isEphemeralThreadMessageId(id: string): boolean {
  return id.startsWith("progress:") || id.startsWith("reasoning:") || isPendingUserMessageId(id);
}

export function pendingUserMessageTextKey(text: string): string {
  return `pending-text:${text}`;
}

export function reasoningMessageId(event: { runId?: string | null; id?: string }): string {
  return `reasoning:${event.runId ?? event.id ?? "live"}`;
}

const FILLER_REASONING_TITLES = new Set(["working through the request", "finished"]);

export function visibleReasoningSteps(steps: ReasoningStep[]): ReasoningStep[] {
  return steps.filter((step) => {
    if (step.detail?.trim()) return true;
    if (step.kind === "tool" || step.kind === "think") return true;
    if (step.kind === "status") {
      return !FILLER_REASONING_TITLES.has(step.title.trim().toLowerCase());
    }
    return Boolean(step.title.trim());
  });
}

export function upsertReasoningStep(steps: ReasoningStep[], step: ReasoningStep): ReasoningStep[] {
  const next = steps.map((entry) => (entry.id === step.id ? { ...entry, ...step } : entry));
  if (next.some((entry) => entry.id === step.id)) return next;
  return [...next, step];
}

export function reasoningStepsFromPayload(
  payload: Record<string, unknown> | undefined,
): ReasoningStep[] {
  const raw = payload?.steps;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    const status = record.status;
    if (kind !== "status" && kind !== "think" && kind !== "tool") return [];
    if (status !== "running" && status !== "done") return [];
    return [
      {
        id: String(record.id ?? ""),
        kind,
        title: String(record.title ?? ""),
        detail: record.detail ? String(record.detail) : undefined,
        status,
      },
    ];
  });
}

export function reasoningToolTitle(name: string, args: Record<string, unknown> = {}): string {
  switch (name) {
    case "shell":
      return "Running a command";
    case "write_file":
      return args.path ? `Writing ${shortPath(String(args.path))}` : "Writing a file";
    case "read_file":
      return args.path ? `Reading ${shortPath(String(args.path))}` : "Reading a file";
    case "list_files":
      return "Listing files";
    case "open_path":
      return args.path ? `Opening ${shortPath(String(args.path))}` : "Opening a path";
    case "computer_observe":
      return "Looking at the screen";
    case "computer_act":
      return "Using the computer";
    case "launch_app":
      return args.application ? `Opening ${String(args.application)}` : "Opening an app";
    case "remember":
      return "Saving a memory";
    case "request_takeover":
      return "Asking you to take over";
    case "run_subagent":
      return args.name ? `Starting ${String(args.name)}` : "Starting a subagent";
    case "spawn_bot":
      return args.name ? `Creating ${String(args.name)}` : "Creating a bot";
    case "destination.write":
      return "Writing to a destination";
    default:
      return `Using ${name.replaceAll("_", " ").replaceAll(".", " ")}`;
  }
}

export function reasoningToolDetail(
  name: string,
  args: Record<string, unknown> = {},
): string | undefined {
  if (name === "shell") return clip(String(args.command ?? ""));
  if (name === "write_file") return clip(String(args.content ?? ""));
  if (name === "remember") return clip(String(args.content ?? args.path ?? ""));
  if (name === "run_subagent") return clip(String(args.task ?? ""));
  if (name === "request_takeover") return clip(String(args.reason ?? ""));
  return undefined;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) || path;
}

function clip(value: string, max = 400): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
