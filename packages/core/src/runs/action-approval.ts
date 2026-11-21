import type { ActionApprovalRule as StoredActionApprovalRule } from "@rakazo/contracts";
import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";

export { isSecretAskBlock } from "../asks/ask-kind.js";

import { humanizeToolName } from "../messages/events.js";

const APPROVAL_EXEMPT_TOOLS = new Set([
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "list_files",
  "user_computer_list",
  "read_file",
  "read_history",
  "search_history",
  "write_file",
  "shell",
  "open_path",
  "launch_app",
  "remember",
  "request_takeover",
  "request_secret",
  "generate_secret",
  "run_subagent",
  "spawn_bot",
  "schedule_create",
  "schedule_list",
  "schedule_update",
  "schedule_cancel",
  "list_fleet",
  "organize_bot",
  // The wallet owner approves every purchase in the wallet itself; a card here would ask twice.
  "request_purchase",
]);

/**
 * Built-ins that only look, or only speak to the owner: free even when outside text started the
 * run. Anything else, new tools included, is gated there (see outsideRunToolRequiresApproval).
 */
const OUTSIDE_RUN_SAFE_BUILTIN_TOOLS = new Set([
  "ask_user",
  "attach_file",
  "browser_snapshot",
  "cloud_agent_status",
  "computer_observe",
  "list_files",
  "user_computer_list",
  "list_fleet",
  "list_secrets",
  "message_user",
  "purchase_status",
  "read_email",
  "read_file",
  "read_history",
  "recall_memory",
  "reflect_memory",
  "request_takeover",
  "run_subagent",
  "schedule_list",
  "scratchpad_list",
  "search_history",
  "service_search",
  "skill_read",
  "task_catalog",
  "web_fetch",
  "web_search",
]);

const APPROVAL_REQUIRED_BUILTIN_TOOLS = new Set([
  "create_calendar_event",
  "create_reminder",
  "complete_reminder",
  "generate_image",
  "generate_video",
  "service_call",
  "archive_bot",
  "secret_request",
  "forget_secret",
  "forget_memory",
  "skill_delete",
  // Permanent, and only for mail the bot received; its owner may still want it.
  "delete_email",
  "cloud_agent_launch",
  "cloud_agent_reply",
  "cloud_agent_cancel",
  "user_computer_shell",
  "user_computer_observe",
  "user_computer_act",
  "feedback",
  "send_email",
  "create_space",
  "set_child_bot_model",
]);
const EXPLICIT_APPROVAL_BUILTIN_TOOLS = new Set([
  // Permanent: the owner sees the exact address before it is theirs for good.
  "claim_email_address",
  "respond_agent_connection",
  "set_child_instructions",
]);

const READ_ONLY_CONNECTOR_PATTERN = /(^|[_-])(get|list|search|find|read)([_-]|$)/i;
/** App slug before a hyphenated action: letters and digits, with at most one underscore. */
const PLAIN_CONNECTOR_SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)?$/;
const MUTATING_CONNECTOR_PATTERN =
  /(^|[_-])(accept|add|approve|archive|assign|buy|cancel|charge|checkout|close|commit|copy|create|delete|deploy|disable|enable|execute|forward|grant|invite|link|mark|merge|modify|move|patch|pay|post|publish|purchase|put|register|reject|remove|rename|replace|reply|reset|revoke|run|schedule|send|set|share|start|stop|submit|subscribe|trigger|unassign|unlink|unsubscribe|update|upload|upsert|write)([_-]|$)/i;
const COMPOUND_CONNECTOR_ACTION_PATTERN = /[_-](and|or|then)[_-]/i;

const EMAIL_CONNECTOR_SLUGS = new Set(["gmail", "outlook", "microsoft_outlook"]);
const PURCHASE_CONNECTOR_SLUGS = new Set(["stripe", "shopify", "paypal", "square"]);

export type ActionApprovalRule = Pick<
  StoredActionApprovalRule,
  "effect" | "matchKind" | "matchValue"
>;

export function connectorKindFromToolName(toolName: string, connectorKinds: string[] = []): string {
  const normalizedTool = toolName.toLowerCase();
  const matched = connectorKinds
    .map((kind) => kind.toLowerCase())
    .filter(
      (kind) =>
        normalizedTool === kind ||
        normalizedTool.startsWith(`${kind}_`) ||
        normalizedTool.startsWith(`${kind}-`),
    )
    .sort((left, right) => right.length - left.length)[0];
  if (matched) return matched;
  const hyphen = normalizedTool.indexOf("-");
  if (hyphen > 0) {
    const slug = normalizedTool.slice(0, hyphen);
    if (PLAIN_CONNECTOR_SLUG.test(slug)) return slug;
  }
  const [segment] = toolName.split("_");
  return (segment ?? toolName).toLowerCase();
}

/**
 * `readOnly` is the connector tool's declared effect (for installed APIs, derived from the stored
 * HTTP method and read-only flag). A declared write always needs approval. A declared read never
 * relaxes the name check: the provider chooses both the name and the hint.
 */
export function connectorToolRequiresApproval(toolName: string, readOnly?: boolean): boolean {
  if (readOnly === false) return true;
  if (MUTATING_CONNECTOR_PATTERN.test(toolName)) return true;
  if (COMPOUND_CONNECTOR_ACTION_PATTERN.test(toolName)) return true;
  return !READ_ONLY_CONNECTOR_PATTERN.test(toolName);
}

/** Unattended watches require explicit read-only metadata and must respect approval rules. */
export function watchToolRefusal(input: {
  toolName: string;
  toolAliases?: readonly string[];
  readOnly?: boolean;
  connectorKind?: string;
  rules: ActionApprovalRule[];
}): string | null {
  const { toolName, readOnly } = input;
  if (readOnly !== true) {
    return `${toolName} can change data, so a change trigger can't run it. Pick a read-only tool.`;
  }
  const decision = resolveActionApprovalDetail({
    toolName,
    toolAliases: input.toolAliases,
    connectorKind: input.connectorKind,
    readOnly,
    rules: input.rules,
  }).decision;
  if (decision === "deny") return `${toolName} is blocked, so a change trigger can't run it.`;
  if (decision === "ask") {
    return `${toolName} needs approval under this space's rules, and a change check cannot ask.`;
  }
  return null;
}

export function toolRequiresApproval(
  toolName: string,
  viaConnector: boolean,
  readOnly?: boolean,
): boolean {
  if (APPROVAL_EXEMPT_TOOLS.has(toolName)) return false;
  if (toolRequiresExplicitApproval(toolName)) return true;
  if (APPROVAL_REQUIRED_BUILTIN_TOOLS.has(toolName)) return true;
  if (viaConnector) return connectorToolRequiresApproval(toolName, readOnly);
  return false;
}

/**
 * A run a webhook or an email started carries text someone else may have written, so a built-in
 * that changes something is gated there even if the owner's own runs never ask for it. It is gated
 * like any other consequential action: Always allow, the approval model or Never ask can pass it.
 */
export function outsideRunToolRequiresApproval(trigger: string, toolName: string): boolean {
  return trigger === "webhook" && !OUTSIDE_RUN_SAFE_BUILTIN_TOOLS.has(toolName);
}

/**
 * Whether this call repeats one of `denied`, the requests a person denied for this tool earlier in
 * the run. A Composio multi-execute repeats only when it shares an inner tool slug. Telling the
 * model not to retry did not stop it.
 */
export function repeatsDeniedAction(input: {
  toolName: string;
  args: unknown;
  denied: unknown[];
}): boolean {
  return input.denied.some((request) => {
    if (input.toolName !== "COMPOSIO_MULTI_EXECUTE_TOOL") return true;
    const before = innerToolSlugs(request);
    return innerToolSlugs(input.args).some((slug) => before.includes(slug));
  });
}

function innerToolSlugs(args: unknown): string[] {
  const tools = (args as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((item) => {
    const slug = (item as { tool_slug?: unknown } | null)?.tool_slug;
    return typeof slug === "string" && slug.trim() ? [slug.trim().toUpperCase()] : [];
  });
}

/** Security-boundary changes cannot be auto-reviewed or permanently allowed. */
export function toolRequiresExplicitApproval(toolName: string): boolean {
  return EXPLICIT_APPROVAL_BUILTIN_TOOLS.has(toolName);
}

/**
 * A run the owner started: their own message in the app or a chat app they linked, a follow-up
 * they wrote, the close of their call, or a routine, whose prompt they wrote. A chat-app message
 * from anyone else (`otherPersonChat`), bot messages, spawns, tickets and webhooks are not, nor is
 * anything new.
 */
export function isOwnerStartedRun(
  trigger: string,
  followUpFromUser: boolean,
  otherPersonChat = false,
): boolean {
  if (trigger === "follow_up") return followUpFromUser;
  if (trigger === "messaging") return !otherPersonChat;
  return trigger === "user" || trigger === "call_end" || trigger === "routine";
}

/**
 * Runs nobody is watching when they ask: a schedule, a webhook, another bot (a message or a new
 * bot's first task) or a ticket started them. An approval card one of them posts expires unanswered after this long, and the action does
 * not run; a card from a chat someone is in stays open until answered.
 */
export const UNATTENDED_APPROVAL_EXPIRE_AFTER_MS = 30 * 60 * 1000;

/** One minute to thirty days, the same span the stuck-work settings accept. */
const UNATTENDED_APPROVAL_MIN_MS = 60 * 1000;
const UNATTENDED_APPROVAL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long an unattended approval card stays open, in ms: the deployment's
 * `UNATTENDED_APPROVAL_EXPIRE_AFTER_MS` when it names a span from one minute to thirty days,
 * else the 30-minute default. A routine that should wait for an evening approval and one that
 * should give up before the next tick cannot both use one constant.
 */
export function unattendedApprovalExpireAfterMs(
  raw: string | undefined = process.env.UNATTENDED_APPROVAL_EXPIRE_AFTER_MS,
): number {
  const value = raw?.trim() ? Number(raw) : Number.NaN;
  return Number.isFinite(value) &&
    value >= UNATTENDED_APPROVAL_MIN_MS &&
    value <= UNATTENDED_APPROVAL_MAX_MS
    ? value
    : UNATTENDED_APPROVAL_EXPIRE_AFTER_MS;
}

const UNATTENDED_TRIGGERS = new Set(["routine", "webhook", "bot_message", "spawn", "tickets"]);

export function approvalCardExpires(trigger: string): boolean {
  return UNATTENDED_TRIGGERS.has(trigger);
}

/**
 * Tools whose results bring in nothing from outside during the run: confirmations of the bot's own
 * writes, the owner's answers, and the product's own saved state (memory, skills, history), which
 * is treated like the conversation already in context. save_page confirms the bot's own write; its
 * read mode returns a page's stored source and taints the run in its handler. Every other result
 * (pages, search hits, files, connector data, the screen, shell output, other bots) can carry text
 * an attacker wrote, and taints the run. New tools taint by default.
 */
const OWN_STATE_RESULT_TOOLS = new Set([
  "ask_user",
  // Only confirms what the bot itself sent.
  "send_email",
  "connect_app",
  "attach_file",
  // Only confirms the bot's own address.
  "claim_email_address",
  "delete_email",
  "end_call",
  "feedback",
  "generate_secret",
  "list_fleet",
  "list_secrets",
  "message_user",
  "read_history",
  "recall_memory",
  "reflect_memory",
  "remember",
  "render_plot",
  "request_secret",
  "save_memory",
  "save_page",
  "save_shared_memory",
  "schedule_cancel",
  "schedule_create",
  "schedule_list",
  "schedule_update",
  "scratchpad_add",
  "scratchpad_complete",
  "scratchpad_list",
  "scratchpad_remove",
  "scratchpad_update",
  "search_history",
  "skill_create",
  "skill_delete",
  "skill_read",
  "skill_update",
  "task_catalog",
  "update_preferences",
  "write_file",
]);

export function toolResultTaintsRun(toolName: string): boolean {
  return !OWN_STATE_RESULT_TOOLS.has(toolName);
}

/**
 * A connector read still sends its arguments to the connector's server. Until outside content
 * enters the run, those arguments come from the owner's request. After that, injected text could
 * choose them, so a read skips approval only on a connector this run already used before then or
 * was approved for. Reads on that connector stay free, so list-then-get flows never ask twice.
 */
export function connectorReadRequiresApproval(input: {
  tainted: boolean;
  connectorTrusted: boolean;
}): boolean {
  return input.tainted && !input.connectorTrusted;
}

const MEMORY_WRITE_TOOLS = new Set(["remember", "save_memory", "save_shared_memory"]);
const SKILL_WRITE_TOOLS = new Set(["skill_create", "skill_update"]);

/**
 * A memory or skill save is checked by the approval model in Auto once outside text entered the
 * run (see isRunTainted): saved text outlives the run, so text written there would steer every
 * later run. Like every taint check it only informs the review; Ask and Never ask treat the save
 * as they treat any other. The predicate is only checked for these writes.
 */
export async function savedContextWriteNeedsReview(
  toolName: string,
  actionTainted: () => Promise<boolean>,
): Promise<boolean> {
  return (
    (MEMORY_WRITE_TOOLS.has(toolName) || SKILL_WRITE_TOOLS.has(toolName)) && (await actionTainted())
  );
}

export type LastingWrite = "memory" | "routine" | "instructions";

/** Providers send omitted optional fields as null or blank; only anything else counts as given. */
export function argumentGiven(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

/**
 * The write that outlives the run an Auto Review is about, which gets its own narrow question:
 * a memory or skill save after outside content, a routine's words, or the bot's own instructions.
 * A routine update writes its words only when it changes its prompt or events; a pause or a new
 * time does not. A child bot's instructions always ask its owner, unreviewed. Each is judged on the
 * owner's own words only.
 */
export function lastingWriteKind(input: {
  toolName: string;
  args: Record<string, unknown>;
  newSite?: boolean;
  savedContextWrite?: boolean;
  ownComputerAction?: boolean;
}): LastingWrite | undefined {
  if (input.newSite || input.ownComputerAction) return undefined;
  if (input.savedContextWrite) return "memory";
  if (input.toolName === "schedule_create" || input.toolName === "create_child_routine")
    return "routine";
  if (
    input.toolName === "schedule_update" &&
    (argumentGiven(input.args.prompt) || argumentGiven(input.args.on))
  )
    return "routine";
  // A blank value leaves the instructions as they are, and a paged read (an offset) only returns
  // the settings, as the update reads its arguments.
  if (
    input.toolName === "update_bot" &&
    argumentGiven(input.args.instructions) &&
    !argumentGiven(input.args.instructions_offset ?? input.args.instructionsOffset)
  )
    return "instructions";
  return undefined;
}

/** What open_path opens as a page rather than a workspace file, as its handler decides. */
const HTTP_LINK = /^https?:\/\//i;
/** Page actions that put text or files the bot chose into the page. */
const PAGE_TYPING_KINDS = new Set(["fill", "type", "upload"]);

function actionsOf(args: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(args.actions)
    ? args.actions.filter(
        (action): action is Record<string, unknown> => !!action && typeof action === "object",
      )
    : [];
}

/**
 * Whether a call on the bot's own computer could send something off it, and so goes to the approval
 * model in Auto once outside text entered the run (see isRunTainted): a shell command, which can
 * reach anything; a page opened, or typed or uploaded into, on a site the run was not given
 * (`pageSiteGiven`, see outboundSiteGate); desktop typing or key presses (which can paste), or an
 * app opened with a URI. Page clicks, pointer moves, scrolling and opening a file or app send
 * nothing the bot chose. Like every taint check it only informs the review; Ask and Never ask treat
 * the call as they treat any other. The predicates are only checked for calls that could send
 * something.
 */
export async function ownComputerActionNeedsReview(
  toolName: string,
  args: Record<string, unknown>,
  checks: { tainted: () => Promise<boolean>; pageSiteGiven: () => Promise<boolean> },
): Promise<boolean> {
  const sends = whatCouldSend(toolName, args);
  if (!sends || !(await checks.tainted())) return false;
  return sends !== "page" || !(await checks.pageSiteGiven());
}

/** "page" when what leaves goes to a page's site, which may be one the run was given. */
function whatCouldSend(
  toolName: string,
  args: Record<string, unknown>,
): "page" | "other" | undefined {
  switch (toolName) {
    case "shell":
      return "other";
    case "browser_navigate":
      return "page";
    case "open_path":
      // Only an http(s) link opens as a page; anything else is a workspace file.
      return HTTP_LINK.test(String(args.path ?? "").trim()) ? "page" : undefined;
    case "browser_act":
      return actionsOf(args).some((action) => PAGE_TYPING_KINDS.has(String(action.kind)))
        ? "page"
        : undefined;
    case "computer_act":
      // Keys can paste or spell out text as well as typing can; only the pointer sends nothing.
      return actionsOf(args).some(
        (action) =>
          action.kind === "type" || action.kind === "key" || String(action.uri ?? "").trim(),
      )
        ? "other"
        : undefined;
    case "launch_app":
      return String(args.uri ?? "").trim() ? "other" : undefined;
    default:
      return undefined;
  }
}

/** A click before what a page action types can leave the page, so the typing lands on another. */
export function clicksBeforeTyping(args: Record<string, unknown>): boolean {
  const kinds = actionsOf(args).map((action) => String(action.kind));
  const firstClick = kinds.indexOf("click");
  return (
    firstClick !== -1 && kinds.slice(firstClick + 1).some((kind) => PAGE_TYPING_KINDS.has(kind))
  );
}

/**
 * web_fetch sends its whole URL, query string included, to the site it names, so a site this run
 * was not given is a new destination that injected text could have picked. Trusted sites (named in
 * the owner's own words, approved earlier in the run, or the exact URL of a search result) and
 * sites with an always-allow rule go through. Anything else is new: planActionGate decides who
 * judges it, and newSiteOutcome what happens when nobody passed it.
 */
export function outboundSiteGate(input: {
  site: string;
  trusted: boolean;
  rules: ActionApprovalRule[];
}): "allow" | "new" {
  return input.trusted || siteAlwaysAllowed(input.rules, input.site) ? "allow" : "new";
}

/**
 * These send data to the site their url names, so a site the run was not given is gated, and
 * "Always allow" on a card naming that site allows the site, never the tool.
 */
export const SITE_SENDING_TOOLS: ReadonlySet<string> = new Set(["web_fetch", "paid_request"]);

export function siteAlwaysAllowed(rules: ActionApprovalRule[], site: string): boolean {
  return rules.some(
    (rule) =>
      rule.effect === "always_allow" &&
      rule.matchKind === "site" &&
      rule.matchValue.toLowerCase() === site,
  );
}

function categoryMatches(
  category: string,
  toolName: string,
  connectorKind: string,
  readOnly: boolean | undefined,
): boolean {
  const normalized = category.toLowerCase();
  const consequential = connectorToolRequiresApproval(toolName, readOnly);
  if (normalized === "email") {
    if (EMAIL_CONNECTOR_SLUGS.has(connectorKind.toLowerCase())) return consequential;
    return consequential && /send.*mail|gmail_send|outlook_send/i.test(toolName);
  }
  if (normalized === "purchase") {
    if (PURCHASE_CONNECTOR_SLUGS.has(connectorKind.toLowerCase())) return consequential;
    return consequential && /purchase|pay_|charge|checkout|buy_/i.test(toolName);
  }
  return false;
}

/**
 * These run code inside Composio that can call any action, so a block scoped to one action could
 * be routed around through them. Any block that is not for a site matches them.
 */
const COMPOSIO_CODE_TOOLS = new Set(["composio_remote_workbench", "composio_remote_bash_tool"]);

function ruleMatches(
  rule: ActionApprovalRule,
  toolName: string,
  connectorKind: string,
  readOnly: boolean | undefined,
  site: string | undefined,
): boolean {
  if (
    rule.effect === "deny" &&
    rule.matchKind !== "site" &&
    COMPOSIO_CODE_TOOLS.has(toolName.toLowerCase())
  ) {
    return true;
  }
  const value = rule.matchValue.toLowerCase();
  switch (rule.matchKind) {
    case "site":
      return site === value;
    case "tool":
      return toolName.toLowerCase() === value;
    case "connector":
      return connectorKind.toLowerCase() === value;
    case "category":
      return categoryMatches(rule.matchValue, toolName, connectorKind, readOnly);
    default:
      return false;
  }
}

function ruleSpecificity(rule: ActionApprovalRule): number {
  switch (rule.matchKind) {
    case "site":
      return 4;
    case "tool":
      return 3;
    case "connector":
      return 2;
    case "category":
      return 1;
    default:
      return 0;
  }
}

export type ActionApprovalSource = "require_approval" | "always_allow" | "deny" | "default";

export type ActionApprovalResolved = {
  decision: "ask" | "allow" | "deny";
  source: ActionApprovalSource;
  matchingRules: ActionApprovalRule[];
  /** The rules that produced this decision; broader matches remain in `matchingRules`. */
  decisiveRules: ActionApprovalRule[];
};

/**
 * The saved rules responsible for an ask or block. Broader rules that also matched
 * are omitted so a refusal points at the decisive rule instead of every candidate.
 */
export function decisiveActionApprovalRules(
  resolved: ActionApprovalResolved,
): ActionApprovalRule[] {
  if (resolved.source !== "require_approval" && resolved.source !== "deny") return [];
  return resolved.decisiveRules.filter((rule) => rule.effect === resolved.source);
}

/**
 * Deterministic rule resolution. A block always wins, so a narrower allow cannot punch through it.
 * Otherwise the most specific rule decides, and `site`, the destination of an outbound fetch,
 * beats a rule for the tool.
 */
export function resolveActionApprovalDetail(input: {
  toolName: string;
  toolAliases?: readonly string[];
  connectorKind?: string;
  readOnly?: boolean;
  site?: string;
  rules: ActionApprovalRule[];
}): ActionApprovalResolved {
  const connectorKind = input.connectorKind ?? connectorKindFromToolName(input.toolName);
  const matchingRules = input.rules.filter(
    (rule) =>
      ruleMatches(rule, input.toolName, connectorKind, input.readOnly, input.site) ||
      (rule.matchKind === "tool" &&
        input.toolAliases?.some((alias) => alias.toLowerCase() === rule.matchValue.toLowerCase())),
  );
  if (matchingRules.length === 0) {
    return { decision: "allow", source: "default", matchingRules, decisiveRules: [] };
  }
  const denyingRules = matchingRules.filter((rule) => rule.effect === "deny");
  if (denyingRules.length > 0) {
    const highestSpecificity = Math.max(...denyingRules.map(ruleSpecificity));
    return {
      decision: "deny",
      source: "deny",
      matchingRules,
      decisiveRules: denyingRules.filter((rule) => ruleSpecificity(rule) === highestSpecificity),
    };
  }

  const highestSpecificity = Math.max(...matchingRules.map(ruleSpecificity));
  const winners = matchingRules.filter((rule) => ruleSpecificity(rule) === highestSpecificity);
  const askingRules = winners.filter((rule) => rule.effect === "require_approval");
  if (askingRules.length > 0) {
    return {
      decision: "ask",
      source: "require_approval",
      matchingRules,
      decisiveRules: askingRules,
    };
  }
  return { decision: "allow", source: "always_allow", matchingRules, decisiveRules: [] };
}

export function resolveActionApproval(input: {
  toolName: string;
  connectorKind?: string;
  readOnly?: boolean;
  rules: ActionApprovalRule[];
}): "ask" | "allow" | "deny" {
  return resolveActionApprovalDetail(input).decision;
}

/**
 * The actions a batch call runs, where `shape` says the call names each one at
 * `args[items][i][action]`. `complete` is false when an entry names no action, or the call lists
 * none: nothing can show what it does, so the call must ask.
 */
export function batchActions(
  shape: { items: string; action: string },
  args: unknown,
): { actions: string[]; complete: boolean } {
  const items =
    args && typeof args === "object" ? (args as Record<string, unknown>)[shape.items] : undefined;
  if (!Array.isArray(items)) return { actions: [], complete: false };
  const actions = new Set<string>();
  let complete = items.length > 0;
  for (const item of items) {
    const action =
      item && typeof item === "object"
        ? (item as Record<string, unknown>)[shape.action]
        : undefined;
    if (typeof action === "string" && action.trim()) actions.add(action.trim());
    else complete = false;
  }
  return { actions: [...actions], complete };
}

/**
 * Rules for every action one call runs. The strictest action decides, so one allowed action never
 * carries the rest of a batch, and the batch is allowed by rule only when each action is. `wrapper`
 * can only block: a block on the batch tool itself or its connector still stops every batch.
 */
export function resolveActionApprovalForTools(input: {
  tools: ReadonlyArray<{
    name: string;
    aliases?: readonly string[];
    connectorKind?: string;
    readOnly?: boolean;
  }>;
  wrapper?: { name: string; connectorKind?: string };
  site?: string;
  rules: ActionApprovalRule[];
}): ActionApprovalResolved {
  const resolve = (tool: {
    name: string;
    aliases?: readonly string[];
    connectorKind?: string;
    readOnly?: boolean;
  }) =>
    resolveActionApprovalDetail({
      toolName: tool.name,
      toolAliases: tool.aliases,
      connectorKind: tool.connectorKind,
      readOnly: tool.readOnly,
      site: input.site,
      rules: input.rules,
    });
  const parts = input.tools.map(resolve);
  const wrapper = input.wrapper ? resolve(input.wrapper) : undefined;
  if (wrapper?.decision === "deny") parts.push(wrapper);
  const matchingRules = [...new Set(parts.flatMap((part) => part.matchingRules))];
  const strictest =
    parts.find((part) => part.decision === "deny") ?? parts.find((part) => part.decision === "ask");
  if (strictest) return { ...strictest, matchingRules };
  const allAllowed = parts.length > 0 && parts.every((part) => part.source === "always_allow");
  return {
    decision: "allow",
    source: allAllowed ? "always_allow" : "default",
    matchingRules,
    decisiveRules: [],
  };
}

/**
 * How much a space asks before acting. `never` runs everything without waiting, `auto` lets the approval model pass what
 * fits the owner's request, and `ask` asks before anything that changes something.
 */
export type ApprovalMode = "never" | "auto" | "ask";

/** The mode a stored preference means. Skipping approvals is Never ask, an enabled review is Auto. */
export function approvalModeFromPreference(preference: {
  enabled: boolean;
  skipApprovals: boolean;
}): ApprovalMode {
  if (preference.skipApprovals) return "never";
  return preference.enabled ? "auto" : "ask";
}

export function approvalPreferenceFromMode(mode: ApprovalMode): {
  enabled: boolean;
  skipApprovals: boolean;
} {
  return { enabled: mode === "auto", skipApprovals: mode === "never" };
}

export type AutoReviewJudgeDecision = "pass" | "ask" | "error";

/**
 * The gate after rule resolution: the approval mode alone decides whether a call asks. A block
 * refuses in every mode. Never ask runs everything else without waiting (the spending limit still
 * applies), except a call `steerable` says outside text could have asked for. A purchase or an
 * approval a person must give asks in Ask and Auto, and no allow rule or review passes it.
 * Otherwise an ask rule asks, and anything that would ask goes to the approval model in Auto,
 * falling back to asking when no model is set up.
 */
export function planActionGate(input: {
  resolved: ActionApprovalResolved;
  mode: ApprovalMode;
  /** Needs a person whatever the rules say (see toolRequiresExplicitApproval). */
  mandatory?: boolean;
  /** Never ask refuses it: the owner did not start this run, or outside content entered it. */
  steerable?: boolean;
  consequential: boolean;
  /**
   * A call outside content may have steered (a connector read, a memory or skill save, a routine
   * naming a new site or adding a trigger, a settings change, an action on the bot's own
   * computer). Only the approval model checks it.
   */
  reviewOnly?: boolean;
  checkerConfigured: boolean;
  /** A fetch to a site the run was not given (see outboundSiteGate). */
  newDestination?: boolean;
  /** A click that completes a purchase: a person approves it each time in Ask and Auto. */
  purchase?: boolean;
}): "ask" | "allow" | "judge" | "deny" {
  if (input.resolved.decision === "deny") return "deny";
  if (input.mode === "never") return input.steerable ? "deny" : "allow";
  if (input.purchase || input.mandatory) return "ask";
  if (input.resolved.decision === "ask") return "ask";
  const review = input.mode === "auto" && input.checkerConfigured ? "judge" : "ask";
  // A rule for the whole tool is not a choice of sites, so it never allows a new one; only a site
  // rule does, and that makes the site no longer new. The approval model judges a new site on the
  // owner's own words and the full URL: it never sees tool results or inbound messages, so text
  // injected there cannot argue for the site.
  if (input.newDestination) return review;
  if (input.resolved.source === "always_allow") return "allow";
  if (input.consequential) return review;
  return input.reviewOnly && review === "judge" ? "judge" : "allow";
}

/** Map a judge outcome onto ask/allow. Errors fail closed on consequential tools. */
export function applyJudgeDecision(input: {
  decision: AutoReviewJudgeDecision;
  consequential: boolean;
}): "ask" | "allow" {
  if (input.decision === "pass") return "allow";
  if (input.decision === "ask") return "ask";
  return input.consequential ? "ask" : "allow";
}

/**
 * The Markdown characters an approval card title escapes in the names it shows, as a regular
 * expression character class. Web renders the title as Markdown; plain-text surfaces unescape them.
 */
export const CARD_TITLE_ESCAPED_CHARACTERS = "[\\\\`*_[\\]<>~|]";

export function isApprovalAskBlock(block: {
  kind: string;
  approvalEffectId?: string;
  actions?: Array<{ id: string; label: string }>;
}): boolean {
  if (block.kind !== "ask" || !block.approvalEffectId || !block.actions?.length) return false;
  const actionIds = new Set(block.actions.map((action) => action.id));
  return (
    actionIds.has("allow") &&
    actionIds.has("deny") &&
    [...actionIds].every((id) => id === "allow" || id === "always" || id === "deny")
  );
}

/**
 * A payment receipt's page lines, leaving out any the page named like one of the card's own rows
 * (`labels`, as the app words them), so merchant text never reads as the card's.
 */
export function receiptItems<Item extends { name: string }>(
  items: readonly Item[],
  labels: readonly string[],
): Item[] {
  const own = labels.map((label) => label.trim().toLocaleLowerCase()).filter(Boolean);
  return items.filter((item) => {
    const name = item.name.trim().toLocaleLowerCase();
    // "Total" and "Total due" pose as the card's row; "Totally Oats" doesn't.
    return !own.some(
      (label) => name.startsWith(label) && !/^[\p{L}\p{N}]/u.test(name.slice(label.length)),
    );
  });
}

/** The order rule lists group by: what goes through, what asks, what is refused. */
export const APPROVAL_RULE_EFFECTS = ["always_allow", "require_approval", "deny"] as const;

/** Whether a rule with this effect does anything in this mode: Never ask honours only blocks. */
export function approvalRuleApplies(
  mode: ApprovalMode | null | undefined,
  effect: ActionApprovalRule["effect"],
): boolean {
  return mode !== "never" || effect === "deny";
}

/**
 * The effects a person can switch a rule to. An older category rule can only be removed, and a tool
 * a person approves every time cannot be allowed, though it can still be blocked.
 */
export function approvalRuleEffectChoices(
  rule: ActionApprovalRule,
): ReadonlyArray<ActionApprovalRule["effect"]> {
  if (rule.matchKind === "category") return [];
  if (rule.matchKind === "tool" && toolRequiresExplicitApproval(rule.matchValue)) {
    return APPROVAL_RULE_EFFECTS.filter((effect) => effect !== "always_allow");
  }
  return APPROVAL_RULE_EFFECTS;
}

/** A site reads as itself; a tool, app or older category by its name. */
export function approvalRuleLabel(rule: ActionApprovalRule): string {
  return rule.matchKind === "site" ? rule.matchValue : humanizeToolName(rule.matchValue);
}

/** A built-in tool a person can add a rule for. */
export type ApprovalRuleChoice = { matchKind: "tool"; matchValue: string; label: string };

/**
 * What the rule picker lists: every built-in tool that has no rule yet, by name. Apps are left out:
 * an app rule matches a kind guessed from the action's name, which some providers' actions lack.
 */
export function approvalRuleChoices(
  rules: ReadonlyArray<ActionApprovalRule>,
): ApprovalRuleChoice[] {
  const taken = new Set(
    rules.filter((rule) => rule.matchKind === "tool").map((rule) => rule.matchValue.toLowerCase()),
  );
  return BUILTIN_TOOL_NAMES.filter((name) => !taken.has(name))
    .map(
      (name): ApprovalRuleChoice => ({
        matchKind: "tool",
        matchValue: name,
        label: humanizeToolName(name),
      }),
    )
    .sort((a, b) => a.label.localeCompare(b.label));
}
