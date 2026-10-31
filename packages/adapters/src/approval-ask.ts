import type { ToolBatch } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import {
  batchActions,
  CARD_TITLE_ESCAPED_CHARACTERS,
  instructionUpdateDiff,
  messagingProviderName,
  redactSecrets,
  sanitizeMessagingLabel,
  toolRequiresExplicitApproval,
} from "@rakazo/core";
import { urlSite } from "@rakazo/core/egress";
import { USER_COMPUTER_SCREEN_TOOLS, userComputerAppName } from "./run-tools-user-computer.js";

export const MAX_APPROVAL_SUMMARY_LENGTH = 500;
export const MAX_APPROVAL_DETAIL_LENGTH = 4_000;
/** Longer fetch URLs are refused, so an approval card always shows the whole URL it sends. */
export const MAX_FETCH_URL_LENGTH = 2_048;
/** These send data to the site their url names, so a site the run was not given is gated. */
export const SITE_SENDING_TOOLS: ReadonlySet<string> = new Set(["web_fetch", "paid_request"]);

/** A fleet card built from the resolved request: a title and the lines under it. */
export type FleetCardSummary = { title: string; lines: string[] };

/**
 * The child instruction card shows the whole new text, so its detail holds the longest
 * instructions plus the two length lines above them.
 */
export function approvalDetailLength(toolName: string): number {
  return toolName === "set_child_instructions"
    ? BOT_INSTRUCTIONS_MAX_LENGTH + MAX_APPROVAL_SUMMARY_LENGTH
    : MAX_APPROVAL_DETAIL_LENGTH;
}

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: { reviewReason?: string; summary?: FleetCardSummary; batch?: ToolBatch },
): MessageBlock {
  if (options?.summary) {
    // Built from what was resolved before the effect was recorded, not from what the model typed.
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: truncate(redactSecrets(options.summary.title, secrets), MAX_APPROVAL_SUMMARY_LENGTH),
      detail: truncate(
        redactSecrets(options.summary.lines.join("\n"), secrets),
        approvalDetailLength(toolName),
      ),
      detailFormat: toolName === "set_child_instructions" ? "code" : "text",
      status: "pending",
      actions: toolRequiresExplicitApproval(toolName)
        ? [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ]
        : [
            { id: "allow", label: "Allow once" },
            { id: "always", label: "Always allow this tool" },
            { id: "deny", label: "Deny" },
          ],
    };
  }
  if (toolName === "respond_agent_connection") {
    const name = sanitizeMessagingLabel(String(args.requester_name ?? "agent")).replace(
      new RegExp(CARD_TITLE_ESCAPED_CHARACTERS, "g"),
      "\\$&",
    );
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: redactSecrets(
        `${args.accept === true ? "Approve" : "Decline"} connection with “${name}”?`,
        secrets,
      ),
      detail: redactSecrets(
        `${messagingProviderName(String(args.requester_provider ?? ""))}: ${String(args.requester_address ?? "").replace(/[\r\n]/g, " ")}`,
        secrets,
      ),
      detailFormat: "text",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    };
  }
  // Only an instruction change held for the owner carries the text it replaces.
  if (toolName === "update_bot" && typeof args.previousInstructions === "string") {
    const before = redactSecrets(String(args.previousInstructions ?? ""), secrets);
    const after = redactSecrets(String(args.instructions ?? ""), secrets);
    const reason = redactSecrets(String(args.reason), secrets);
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: "Update instructions?",
      detail: instructionUpdateDiff(before, after, reason),
      instructionUpdate: {
        botId: String(args.botId ?? ""),
        before,
        after,
        reason,
      },
      detailFormat: "code",
      status: "pending",
      actions: [
        { id: "allow", label: "Apply" },
        { id: "deny", label: "Dismiss" },
      ],
    };
  }
  if (USER_COMPUTER_SCREEN_TOOLS.has(toolName)) {
    const app = userComputerAppName(args.app).replace(
      new RegExp(CARD_TITLE_ESCAPED_CHARACTERS, "g"),
      "\\$&",
    );
    const steps = Array.isArray(args.actions) ? args.actions.map(screenActionLine) : [];
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: `Use ${app || "an app"} on your computer?`,
      ...(steps.length
        ? {
            detail: truncate(redactSecrets(steps.join("\n"), secrets), MAX_APPROVAL_DETAIL_LENGTH),
            detailFormat: "code" as const,
          }
        : {}),
      status: "pending",
      actions: [
        { id: "allow", label: "Allow in this space" },
        { id: "deny", label: "Deny" },
      ],
    };
  }
  if (toolName === "user_computer_shell") {
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? `cd ${args.cwd.trim()}\n` : "";
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: "Run on your computer?",
      detail: truncate(
        redactSecrets(`${cwd}${String(args.command ?? "")}`, secrets),
        MAX_APPROVAL_DETAIL_LENGTH,
      ),
      detailFormat: "code",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow in this space" },
        { id: "deny", label: "Deny" },
      ],
    };
  }
  const fetchSite = webFetchSite(toolName, args);
  const summary = describeApprovalAction(toolName, args, options?.batch);
  const detail = formatApprovalDetail(toolName, args, options?.reviewReason, options?.batch);
  const safeDetail = detail ? redactSecrets(detail, secrets) : undefined;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: truncate(
      redactSecrets(
        toolName === "create_space" ? `${summary}?` : `Review before ${summary}`,
        secrets,
      ),
      MAX_APPROVAL_SUMMARY_LENGTH,
    ),
    detail: safeDetail ? truncate(safeDetail, MAX_APPROVAL_DETAIL_LENGTH) : undefined,
    ...(fetchSite ? { site: fetchSite } : {}),
    status: "pending",
    actions:
      toolName === "create_space"
        ? [
            { id: "allow", label: "Create space", outcome: "created" },
            { id: "deny", label: "Cancel", outcome: "cancelled" },
          ]
        : toolRequiresExplicitApproval(toolName)
          ? [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ]
          : [
              { id: "allow", label: "Allow once" },
              {
                id: "always",
                label: fetchSite ? `Always allow ${fetchSite}` : "Always allow this tool",
              },
              { id: "deny", label: "Deny" },
            ],
  };
}

function webFetchSite(toolName: string, args: Record<string, unknown>): string | undefined {
  return SITE_SENDING_TOOLS.has(toolName) && typeof args.url === "string"
    ? urlSite(args.url)
    : undefined;
}

function describeApprovalAction(
  toolName: string,
  args: Record<string, unknown>,
  batchShape: ToolBatch | undefined,
): string {
  // A batch is named by the actions it runs; "…" stands for an entry that names none.
  const batch = batchShape && batchActions(batchShape, args);
  if (batch?.actions.length) {
    return [...batch.actions, ...(batch.complete ? [] : ["…"])].join(", ");
  }
  if (toolName === "delete_bot" || toolName === "archive_bot") {
    const name = args.confirm_name ?? args.confirmName;
    return name ? `${toolName.replace("_", " ")} (${String(name)})` : toolName.replace("_", " ");
  }
  if (toolName === "create_space") {
    const name = args.name ? String(args.name) : "Untitled";
    return `Create space “${name}”`;
  }
  const target = webFetchSite(toolName, args) ?? pickScopeLabel(args);
  return target ? `${toolName} → ${target}` : toolName;
}

function formatApprovalDetail(
  toolName: string,
  args: Record<string, unknown>,
  reviewReason: string | undefined,
  batch: ToolBatch | undefined,
): string | undefined {
  const lines: string[] = [];
  if (reviewReason?.trim()) {
    lines.push(reviewReason.trim().replace(/\u2014|\u2013/g, "-"));
  }
  if (toolName === "create_space") {
    lines.push(
      "Bots, groups, chats, files, memory, and integrations in this space stay separate from other spaces.",
    );
  }
  // A fetch carries data in its path and query, so the card shows the whole URL.
  const keys = SITE_SENDING_TOOLS.has(toolName)
    ? ["url", "method", "body"]
    : ["collection", "title", "to", "recipient_email", "cc", "bcc", "subject", "amount", "body"];
  const pushArgs = (values: Record<string, unknown>) => {
    for (const key of keys) {
      const value = values[key];
      if (value == null || value === "") continue;
      lines.push(`${key}: ${String(value)}`);
    }
  };
  const items = batch ? args[batch.items] : undefined;
  if (batch && Array.isArray(items)) {
    for (const item of items) {
      const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const action = entry[batch.action];
      lines.push((typeof action === "string" && action.trim()) || "…");
      pushArgs(objectArguments(entry[batch.arguments]));
    }
  } else {
    pushArgs(args);
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

/** A batch entry's arguments, as an object or a JSON string. */
function objectArguments(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function pickScopeLabel(args: Record<string, unknown>): string | undefined {
  for (const key of ["to", "title", "collection", "subject", "amount"]) {
    const value = args[key];
    if (value != null && value !== "") return String(value);
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function screenActionLine(value: unknown): string {
  const action = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const at =
    action.element !== undefined
      ? ` [${String(action.element)}]`
      : action.x !== undefined
        ? ` ${String(action.x)},${String(action.y)}`
        : "";
  switch (action.kind) {
    case "type":
      return `type ${JSON.stringify(String(action.text ?? ""))}${at}`;
    case "set":
      return `set${at} to ${JSON.stringify(String(action.value ?? ""))}`;
    case "key":
      return `key ${[...(Array.isArray(action.modifiers) ? action.modifiers : []), action.key].join("+")}`;
    case "scroll":
      return `scroll ${String(action.direction ?? "")}${at}`;
    case "menu":
      return `menu ${(Array.isArray(action.path) ? action.path : []).join(" > ")}`;
    case "wait":
      return `wait ${String(action.ms ?? 0)}ms`;
    default:
      return `${String(action.kind ?? "action")}${at}`;
  }
}
