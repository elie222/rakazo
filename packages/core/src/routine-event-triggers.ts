import {
  type ChatMatchKind,
  type ChatTriggerScope,
  type RepoEventKind,
  type RoutineChatTrigger,
  type RoutineEventTrigger,
  type RoutineEventTriggers,
  RoutineEventTriggersSchema,
  type RoutineRepoTrigger,
} from "@rakazo/contracts";

export type NormalizedRepoEvent = {
  source: "repo";
  repo: string;
  event: RepoEventKind;
  payload: Record<string, unknown>;
};

export type NormalizedChatEvent = {
  source: "chat";
  provider: string;
  scope: ChatTriggerScope;
  /** Channel name/id or DM peer address/label candidates. */
  targets: string[];
  text: string;
  mentioned: boolean;
  reaction: boolean;
  payload: Record<string, unknown>;
};

export type NormalizedWebhookEvent = {
  source: "webhook";
  payload: Record<string, unknown>;
};

export type NormalizedRoutineEvent =
  | NormalizedWebhookEvent
  | NormalizedRepoEvent
  | NormalizedChatEvent;

export function parseRoutineEventTriggers(value: unknown): RoutineEventTriggers {
  const parsed = RoutineEventTriggersSchema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

/** Keep the legacy boolean aligned with webhook trigger records. */
export function webhookEnabledFromTriggers(triggers: RoutineEventTriggers): boolean {
  return triggers.some((trigger) => trigger.kind === "webhook");
}

/**
 * Slack, Telegram, and WhatsApp inbound is DM-only. Groups are iMessage-only.
 * Chat triggers in the product UI are Slack-branded, so channel scope never
 * fires for the providers those triggers target.
 */
export const UNSUPPORTED_CHAT_CHANNEL_TRIGGER_MESSAGE =
  "Chat channel triggers are not supported. Slack, Telegram, and WhatsApp only deliver DMs.";

export function hasChatChannelTriggers(triggers: RoutineEventTriggers): boolean {
  return triggers.some((trigger) => trigger.kind === "chat" && trigger.scope === "channel");
}

/** Drop channel-scoped chat triggers that cannot receive Slack/Telegram/WhatsApp events. */
export function withoutChatChannelTriggers(triggers: RoutineEventTriggers): RoutineEventTriggers {
  return triggers.filter((trigger) => !(trigger.kind === "chat" && trigger.scope === "channel"));
}

/**
 * Merge legacy webhookEnabled into trigger records when the JSON list is empty.
 * Prefer eventTriggers when present. Always drop channel-scoped chat triggers so
 * dispatch cannot wake hidden configs that the editor no longer shows.
 */
export function coalesceRoutineEventTriggers(
  eventTriggers: unknown,
  webhookEnabled: boolean,
): RoutineEventTriggers {
  const parsed = withoutChatChannelTriggers(parseRoutineEventTriggers(eventTriggers));
  if (parsed.length > 0) {
    if (webhookEnabled && !parsed.some((trigger) => trigger.kind === "webhook")) {
      return [...parsed, { id: "legacy-webhook", kind: "webhook" }];
    }
    return parsed;
  }
  if (webhookEnabled) return [{ id: "legacy-webhook", kind: "webhook" }];
  return [];
}

export function newRoutineEventTriggerId(kind: RoutineEventTrigger["kind"]): string {
  return `${kind}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeRepoName(repo: string): string {
  return repo
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

export function matchRepoTrigger(trigger: RoutineRepoTrigger, event: NormalizedRepoEvent): boolean {
  if (normalizeRepoName(trigger.repo) !== normalizeRepoName(event.repo)) return false;
  return trigger.events.includes(event.event);
}

function normalizeTarget(value: string): string {
  return value
    .trim()
    .replace(/^<@/, "")
    .replace(/>$/, "")
    .replace(/^[#@]+/, "")
    .toLowerCase();
}

/**
 * True when `text` mentions this bot via an explicit token (@Name, <@id>, etc.).
 * Any bare @word does not count.
 */
export function textMentionsBot(text: string, mentionTokens: string[]): boolean {
  const haystack = text.toLowerCase();
  for (const raw of mentionTokens) {
    const token = raw.trim();
    if (!token) continue;
    const bare = normalizeTarget(token);
    if (!bare) continue;
    if (haystack.includes(`<@${bare}>`)) return true;
    if (new RegExp(`(^|\\s)@${escapeRegExp(bare)}(?=$|\\s|[.,!?])`, "i").test(text)) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchChatTrigger(trigger: RoutineChatTrigger, event: NormalizedChatEvent): boolean {
  if (trigger.scope !== event.scope) return false;
  const wanted = normalizeTarget(trigger.target);
  if (!wanted) return false;
  if (!event.targets.some((target) => normalizeTarget(target) === wanted)) return false;

  switch (trigger.match) {
    case "mention":
      return event.mentioned && event.text.trim().length > 0;
    case "keyword": {
      const keyword = trigger.keyword?.trim().toLowerCase();
      if (!keyword) return false;
      return event.text.toLowerCase().includes(keyword);
    }
    case "message":
      return event.text.trim().length > 0;
    case "reaction":
      return event.reaction;
    default:
      return false;
  }
}

export function triggerMatchesEvent(
  trigger: RoutineEventTrigger,
  event: NormalizedRoutineEvent,
): boolean {
  if (trigger.kind === "webhook") return event.source === "webhook";
  if (trigger.kind === "repo") {
    return event.source === "repo" && matchRepoTrigger(trigger, event);
  }
  return event.source === "chat" && matchChatTrigger(trigger, event);
}

export function matchingEventTriggers(
  triggers: RoutineEventTriggers,
  event: NormalizedRoutineEvent,
): RoutineEventTrigger[] {
  return triggers.filter((trigger) => triggerMatchesEvent(trigger, event));
}

/**
 * Map common GitHub webhook envelopes (and a small neutral shape) onto repo events.
 * Returns null when the payload is not a recognizable repo event.
 */
export function normalizeRepoEventPayload(
  payload: Record<string, unknown>,
  headers: { eventName?: string | null } = {},
): NormalizedRepoEvent | null {
  const neutralRepo = typeof payload.repo === "string" ? payload.repo : null;
  const neutralEvent = typeof payload.event === "string" ? payload.event : null;
  if (neutralRepo && neutralEvent) {
    const mapped = mapNeutralRepoEvent(neutralEvent);
    if (mapped) {
      return {
        source: "repo",
        repo: normalizeRepoName(neutralRepo),
        event: mapped,
        payload,
      };
    }
  }

  const repository = asRecord(payload.repository);
  const fullName =
    (typeof repository?.full_name === "string" && repository.full_name) ||
    (typeof payload.repository === "string" ? payload.repository : null);
  if (!fullName) return null;

  const ghEvent = headers.eventName?.trim() || (typeof payload.action === "string" ? "" : "");
  const action = typeof payload.action === "string" ? payload.action : "";
  const event = mapGithubEvent(ghEvent || inferGithubEventFromPayload(payload), action, payload);
  if (!event) return null;

  return {
    source: "repo",
    repo: normalizeRepoName(fullName),
    event,
    payload,
  };
}

function mapNeutralRepoEvent(value: string): RepoEventKind | null {
  const key = value.trim().toLowerCase().replace(/[-\s]/g, "_");
  const aliases: Record<string, RepoEventKind> = {
    pr_opened: "pr_opened",
    pull_request_opened: "pr_opened",
    pull_request_open: "pr_opened",
    opened: "pr_opened",
    pr_merged: "pr_merged",
    pull_request_merged: "pr_merged",
    merged: "pr_merged",
    push: "push",
    review: "review",
    pull_request_review: "review",
    comment: "comment",
    issue_comment: "comment",
    pull_request_review_comment: "comment",
    ci: "ci",
    check_suite: "ci",
    check_run: "ci",
    workflow_run: "ci",
    status: "ci",
  };
  return aliases[key] ?? null;
}

function inferGithubEventFromPayload(payload: Record<string, unknown>): string {
  if (payload.pull_request && payload.review) return "pull_request_review";
  if (payload.pull_request) return "pull_request";
  if (payload.commits || payload.head_commit) return "push";
  if (payload.check_suite || payload.check_run || payload.workflow_run) return "check_suite";
  if (payload.comment) return "issue_comment";
  return "";
}

function mapGithubEvent(
  eventName: string,
  action: string,
  payload: Record<string, unknown>,
): RepoEventKind | null {
  const name = eventName.toLowerCase();
  if (name === "push") return "push";
  if (name === "pull_request") {
    if (action === "opened" || action === "reopened" || action === "ready_for_review") {
      return "pr_opened";
    }
    if (action === "closed" && asRecord(payload.pull_request)?.merged === true) {
      return "pr_merged";
    }
    return null;
  }
  if (name === "pull_request_review") return "review";
  if (name === "issue_comment" || name === "pull_request_review_comment") return "comment";
  if (
    name === "check_suite" ||
    name === "check_run" ||
    name === "workflow_run" ||
    name === "status"
  ) {
    return "ci";
  }
  return mapNeutralRepoEvent(name);
}

export function formatRoutineEventPrompt(
  routinePrompt: string,
  event: NormalizedRoutineEvent,
): string {
  const instruction = routinePrompt.trim();
  const body = formatEventBlock(event);
  return instruction ? `${instruction}\n\n${body}` : body;
}

function formatEventBlock(event: NormalizedRoutineEvent): string {
  if (event.source === "webhook") {
    return formatWebhookBlock(event.payload);
  }
  if (event.source === "repo") {
    return `[Repo event: ${event.event} on ${event.repo}]\n\`\`\`json\n${JSON.stringify(event.payload, null, 2)}\n\`\`\``;
  }
  const where =
    event.scope === "dm" ? `dm ${event.targets[0] ?? ""}`.trim() : `#${event.targets[0] ?? ""}`;
  return `[Chat event: ${event.provider} ${where}]\n${event.text.trim() || "(reaction)"}`;
}

function formatWebhookBlock(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string" && payload.text.trim()) {
    return payload.text.trim();
  }
  const eventName = typeof payload.event === "string" ? payload.event : "webhook";
  return `[Inbound Event: ${eventName}]\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function chatMatchLabel(match: ChatMatchKind): string {
  switch (match) {
    case "mention":
      return "mention";
    case "keyword":
      return "keyword";
    case "message":
      return "message";
    case "reaction":
      return "reaction";
  }
}

export function repoEventLabel(event: RepoEventKind): string {
  switch (event) {
    case "pr_opened":
      return "PR opened";
    case "pr_merged":
      return "PR merged";
    case "push":
      return "Push";
    case "review":
      return "Review";
    case "comment":
      return "Comment";
    case "ci":
      return "CI";
  }
}
