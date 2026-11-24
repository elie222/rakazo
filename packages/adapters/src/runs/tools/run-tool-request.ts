import type { ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";
import { BOT_INSTRUCTIONS_MAX_LENGTH, BotSecretAuth, OneTimeCodeTarget } from "@rakazo/contracts";
import { approvalCardExpires, redactSecrets } from "@rakazo/core";
import { runLoginKind } from "@rakazo/db";
import type { FleetCardSummary } from "../../approvals/approval-ask.js";
import type { TerminatingToolResult } from "../../approvals/approval-effect.js";
import {
  approvalReplayPathError,
  approvalReplayResourceError,
  approvalRoutesMatch,
  approvedCatalogReplay,
  approvedReplayArgs,
  boundDirectApprovalDetails,
  boundDirectApprovalRequest,
  catalogApprovalDetails,
  catalogApprovalInnerArgs,
  catalogApprovalMatchesLiveRoute,
  catalogApprovalRequest,
} from "../../approvals/approval-effect.js";
import { prepareAgentConnectionResponse } from "../../bots/agent-connections.js";
import { childSettingsGiven, prepareChildBotUpdate } from "../../bots/child-bot-settings.js";
import { listDefaultVoices } from "../../bots/own-bot-settings.js";
import {
  argumentGiven,
  BOT_SETTING_ARGS,
  dropUnchangedOwnBotArgs,
} from "../../bots/update-bot-patch.js";
import { validCloudAgentArgs } from "../../cloud-agents/cloud-agent-tools.js";
import { sanitizeConnectorError } from "../../integrations/connector-safety.js";
import { paidRequestEffect, restorePaidRequest } from "../../payments/paid-request.js";
import type { PurchaseApproval, UncheckedPress } from "../../payments/purchase-gate.js";
import {
  detectPurchase,
  PURCHASE_CHECKED_TOOLS,
  purchaseApprovalOf,
  purchaseCardSummary,
} from "../../payments/purchase-gate.js";
import { routineRunUsesOwnerComputer } from "../../routines/routine-owner-computer.js";
import { reachesManagedRoutines } from "../../routines/routine-target.js";
import { canonicalToolEvents } from "../../routines/routine-triggers.js";
import { listVaultItems } from "../../secrets/bot-secrets.js";
import type { VaultCardUse, VaultLoginUse } from "../../secrets/vault/vault-card-use.js";
import {
  cardUseSummary,
  loginUseSummary,
  requestedCardUse,
  requestedLoginFills,
  vaultCardUseOf,
  vaultLoginUseOf,
} from "../../secrets/vault/vault-card-use.js";
import {
  isFleetApprovalTool,
  modelLabel,
  prepareFleetRequest,
  resolveBot,
} from "../../tools/fleet-tools.js";
import { assertConnectorToolArgs, CATALOG_EXECUTE } from "../../tools/lazy-tool-catalog.js";
import { SCHEDULE_TOOL_NAMES } from "../../tools/schedule-tools.js";
import { SKILL_TOOL_NAMES } from "../../tools/skill-tools.js";
import type { RunContext } from "../assembly/run-context.js";
import {
  markReadOutsideContent,
  neverAsks,
  OWN_INSTRUCTIONS_BASELINE_UNKNOWN_ERROR,
} from "../assembly/run-context.js";
import {
  approvalReplayEffectToolName,
  CATALOG_APPROVAL_TOOL,
  isSubagentToolExecution,
} from "../lifecycle/run-effects.js";
import { fleetPrepareDeps } from "../turn/run-model.js";
import { refusal } from "../turn/tool-refusal.js";
import { BUILTIN_AGENT_TOOL_NAMES, FLEET_WRITE_TOOL_NAMES_SET } from "./run-tool-selection.js";
import { holdSharedPageSave } from "./run-tools-pages.js";
import { scheduleCreateRefusal, scheduleUpdatePreview } from "./run-tools-tasks.js";
import { USER_COMPUTER_TOOLS } from "./run-tools-user-computer.js";

/** A tool call resolved to the tool it runs and the exact request an approval covers. */
export interface ToolRequest {
  name: string;
  args: Record<string, unknown>;
  executionId: string;
  connectorCall: ConnectorCall;
  /** The persisted request an approval covers; catalog and bound routes wrap the args. */
  effectRequest: unknown;
  /** The connector tool a catalog call resolved to. */
  resolvedTool: ConnectorTool | undefined;
  catalogRemapped: boolean;
  /** The approved effect this attempt must replay next, if any. */
  nextApprovedTool: string | undefined;
  approvedEffectKey: string | undefined;
  replayEffectToolName: string;
  fleetSummary: FleetCardSummary | undefined;
  /** Gated like a consequential action, even when the tool alone is not. */
  heldForApproval: boolean;
  /** Changes the owner's or this bot's settings: the approval model checks it after outside text. */
  settingsChange: boolean;
  /** Outside text may have asked for it, so a saved Always allow rule does not skip its approval. */
  ignoresAllowRules: boolean;
  /** This page tool call completes a purchase, which a person approves each time. */
  purchase: PurchaseApproval | undefined;
  /** This page tool call types a saved card into a checkout, which a person approves each time. */
  cardUse: VaultCardUse | undefined;
  /** This browser_act call signs in with a saved login that asks first, approved like a card. */
  loginUse: VaultLoginUse | undefined;
}

type ToolError = { error: string };

/** A prepare-step refusal: a plain error, or a result that ends the turn on a repeat. */
type PrepareRefusal = ToolError | TerminatingToolResult;

/**
 * Resolve catalog and bound connector routes, and line the call up with the next approved
 * effect this attempt must replay.
 */
export async function resolveToolRequest(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
): Promise<ToolRequest | ToolError> {
  const { deps, context } = ctx;
  const approvedReplays = ctx.tools.approvedReplays;
  let connectorCall: ConnectorCall = {
    tool: name,
    args,
    executionId,
    route: ctx.tools.connector.get(name)?.route,
  };
  const onCatalogExecuteRoute = Boolean(
    connectorCall.route &&
      !connectorCall.route.resourceId &&
      connectorCall.route.toolName === CATALOG_EXECUTE,
  );
  const approvedReplay = approvedCatalogReplay(
    approvedReplays,
    name,
    CATALOG_APPROVAL_TOOL,
    onCatalogExecuteRoute,
  );
  if (approvedReplay.error) return { error: approvedReplay.error };
  if (approvedReplay.args) connectorCall.args = approvedReplay.args;
  let catalogRemapped = false;
  let resolvedTool: ConnectorTool | undefined;
  if (name.startsWith("cloud_agent_") && !validCloudAgentArgs(name, args)) {
    return refusal(
      "invalid_cloud_agent_arguments",
      "Invalid cloud agent arguments. Raw environment variables are not supported.",
    );
  }
  let effectRequest: unknown = name === "paid_request" ? paidRequestEffect(args) : args;
  if (connectorCall.route && deps.connector?.resolveCall) {
    try {
      const resolved = await deps.connector.resolveCall(connectorCall, context);
      if (resolved) {
        if (BUILTIN_AGENT_TOOL_NAMES.has(resolved.tool.name)) {
          return refusal(
            "connector_name_conflict",
            "Connector tool name conflicts with a built-in tool",
          );
        }
        name = resolved.tool.name;
        args = resolved.call.args;
        catalogRemapped = true;
        resolvedTool = resolved.tool;
        effectRequest = catalogApprovalRequest(
          connectorCall.tool,
          connectorCall.args,
          CATALOG_APPROVAL_TOOL,
          resolved.tool.route?.resourceId &&
            resolved.tool.route.connectorId &&
            resolved.tool.route.toolName
            ? {
                connectorId: resolved.tool.route.connectorId,
                resourceId: resolved.tool.route.resourceId,
                resourceRevision: resolved.tool.route.resourceRevision,
                connectionId: resolved.tool.route.connectionId,
                toolName: resolved.tool.route.toolName,
              }
            : undefined,
        );
        connectorCall = resolved.call;
      }
    } catch (error) {
      await markReadOutsideContent(ctx);
      return { error: sanitizeConnectorError(error) };
    }
  }
  if (approvedReplay.args && !catalogRemapped) {
    return refusal(
      "approved_catalog_request_unresolved",
      "Approved catalog request could not be resolved to a tool. Deny and retry the direct tool call.",
    );
  }
  if (
    !catalogRemapped &&
    connectorCall.route?.resourceId &&
    connectorCall.route.connectorId &&
    connectorCall.route.toolName
  ) {
    effectRequest = boundDirectApprovalRequest(
      {
        connectorId: connectorCall.route.connectorId,
        resourceId: connectorCall.route.resourceId,
        resourceRevision: connectorCall.route.resourceRevision,
        connectionId: connectorCall.route.connectionId,
        toolName: connectorCall.route.toolName,
      },
      args,
      CATALOG_APPROVAL_TOOL,
    );
  }
  // Approval applies to the exact persisted request, never to a payload the model
  // reconstructs after the worker resumes. This also makes a changed reconstruction
  // hit the already-approved effect instead of creating a second approval card.
  const nextApprovedTool = approvedReplays.nextToolName();
  let approvedEffectKey: string | undefined;
  const nextApprovedRequest = approvedReplays.nextRequest();
  const liveRoute =
    connectorCall.route?.resourceId &&
    connectorCall.route.connectorId &&
    connectorCall.route.toolName
      ? {
          connectorId: connectorCall.route.connectorId,
          resourceId: connectorCall.route.resourceId,
          resourceRevision: connectorCall.route.resourceRevision,
          connectionId: connectorCall.route.connectionId,
          toolName: connectorCall.route.toolName,
        }
      : undefined;
  const nextBound = boundDirectApprovalDetails(nextApprovedRequest, CATALOG_APPROVAL_TOOL);
  const nextCatalog = catalogApprovalDetails(nextApprovedRequest, CATALOG_APPROVAL_TOOL);
  // After collision uniquify, the live tool name may differ from the stored effect
  // kind while still targeting the same bound connector resource.
  const sameBoundResource = Boolean(
    nextBound && liveRoute && approvalRoutesMatch(nextBound.route, liveRoute),
  );
  // After catalog shrink, a catalog approval may resume as the matching direct tool.
  const sameCatalogTarget = Boolean(
    nextCatalog && catalogApprovalMatchesLiveRoute(nextCatalog, liveRoute),
  );
  if (nextApprovedTool && nextApprovedTool !== name && !sameBoundResource && !sameCatalogTarget) {
    return refusal(
      "approved_request_not_replayed",
      `Approved request ${nextApprovedTool} must be replayed before ${name}.`,
    );
  }
  // Drain FIFO only when the pending approval matches this path (catalog vs direct).
  const replayEffectToolName = approvalReplayEffectToolName(
    name,
    nextApprovedTool,
    sameBoundResource || sameCatalogTarget,
  );
  if (nextApprovedTool && (nextApprovedTool === name || sameBoundResource || sameCatalogTarget)) {
    const pathError = approvalReplayPathError(
      name,
      catalogRemapped,
      nextApprovedRequest,
      CATALOG_APPROVAL_TOOL,
      liveRoute,
    );
    if (pathError) return { error: pathError };
    const resourceError = approvalReplayResourceError(
      name,
      catalogRemapped,
      nextApprovedRequest,
      liveRoute,
      CATALOG_APPROVAL_TOOL,
    );
    if (resourceError) return { error: resourceError };
    approvedEffectKey = approvedReplays.nextIdempotencyKey();
    const approvedRequest = approvedReplays.take(nextApprovedTool)!;
    const approvedCatalog = catalogApprovalDetails(approvedRequest, CATALOG_APPROVAL_TOOL);
    if (approvedCatalog && !catalogRemapped) {
      // Shrink-to-direct: restore approved inner arguments, not the wrapper envelope.
      const innerArgs = catalogApprovalInnerArgs(approvedCatalog);
      if (!innerArgs) {
        return refusal(
          "approved_catalog_request_missing_arguments",
          `Approved catalog request ${name} is missing tool arguments.`,
        );
      }
      args = innerArgs;
    } else {
      // Catalog wrappers keep resolveCall's parsed args so Zod stripping/coercion
      // still matches the first-approval effect key and execute payload.
      const live = args;
      args = approvedReplayArgs(approvedRequest, args, CATALOG_APPROVAL_TOOL);
      if (name === "paid_request") {
        const restored = restorePaidRequest(args, live);
        if ("error" in restored && typeof restored.error === "string")
          return { error: restored.error };
        args = restored;
      }
    }
    // Bound / shrink-direct approvals may skip catalog parse — reject before execute
    // if they no longer match the live schema.
    if (
      boundDirectApprovalDetails(approvedRequest, CATALOG_APPROVAL_TOOL) ||
      (approvedCatalog && !catalogRemapped)
    ) {
      const liveSchema = (resolvedTool ?? ctx.tools.connector.get(name))?.inputSchema;
      if (liveSchema) {
        try {
          assertConnectorToolArgs(liveSchema, args);
        } catch (error) {
          await markReadOutsideContent(ctx);
          return { error: sanitizeConnectorError(error) };
        }
      }
    }
  }
  return {
    name,
    args,
    executionId,
    connectorCall,
    effectRequest,
    resolvedTool,
    catalogRemapped,
    nextApprovedTool,
    approvedEffectKey,
    replayEffectToolName,
    fleetSummary: undefined,
    heldForApproval: false,
    settingsChange: false,
    ignoresAllowRules: false,
    purchase: undefined,
    cardUse: undefined,
    loginUse: undefined,
  };
}

/**
 * The saved login that asks first this browser_act call fills: every field it fills, on the one
 * of its sites it fills there, as saved now. A replay keeps the approval the user answered.
 */
async function askingLoginUse(
  ctx: RunContext,
  actions: unknown,
  /** The user's answer this call replays; its approval for a login, if any, is `given`. */
  replay: boolean,
  given: unknown,
): Promise<VaultLoginUse | ToolError | undefined> {
  const { deps, run } = ctx;
  const asking: VaultLoginUse[] = [];
  for (const [login, fields] of requestedLoginFills(actions)) {
    // This run's login that wasn't saved is what the person just typed, and is filled instead.
    const kind = runLoginKind(run.id, login);
    if (
      await deps.prisma.secret.count({ where: { userId: run.userId, spaceId: run.spaceId, kind } })
    )
      continue;
    // A login's title never comes from its value, so it isn't decrypted here.
    const [item] = await listVaultItems(deps.prisma, deps.secretStore, run, login, false);
    if (item?.policy !== "ask" || BotSecretAuth.safeParse(item.auth).data?.type !== "login")
      continue;
    const savedAt = item.updatedAt.toISOString();
    // Where it fills: the page's site when that is one of its others, as the fill reads it.
    const url = ctx.state.pageUrl;
    const page = url && URL.canParse(url) ? new URL(url).origin : "";
    const site = item.alsoOn?.includes(page) ? page : item.origin;
    // Saved where no approval can name, as under older rules, it is never typed: the fill refuses.
    if (![item.origin, site].every((origin) => OneTimeCodeTarget.safeParse({ origin }).success))
      continue;
    asking.push({
      kind: "login",
      login,
      site,
      title: item.title,
      fields,
      savedAt,
    });
  }
  const [wanted] = asking;
  if (!wanted) return undefined;
  if (asking.length > 1)
    return { error: "Sign in with one saved login that asks first per browser_act call." };
  const approved = replay ? vaultLoginUseOf(given) : undefined;
  if (!approved && !replay) return wanted;
  // An answer given for something else, such as before the login asked first, never covers it.
  if (!approved)
    return {
      error:
        "This signs in with a saved login the user has not approved, so nothing was typed. Call the tool again; that asks the user.",
    };
  if (approved.login !== wanted.login || approved.fields.join("\n") !== wanted.fields.join("\n"))
    return {
      error:
        "This signs in with a saved login the user has not approved for these fields, so nothing was typed. Call the tool again; that asks the user.",
    };
  return approved;
}

function archivesItself(
  bot: { id: string; name: string },
  name: string,
  args: Record<string, unknown>,
) {
  if (name !== "archive_bot") return false;
  const botId = args.bot_id || args.botId;
  if (botId) return String(botId) === bot.id;
  return String(args.confirm_name ?? args.confirmName ?? "").trim() === bot.name;
}

/**
 * Check bot-management and instruction-proposal preconditions, and canonicalize the
 * requests whose approval card shows resolved names. Updates the request in place.
 */
export async function prepareToolRequest(
  ctx: RunContext,
  request: ToolRequest,
): Promise<PrepareRefusal | undefined> {
  const { deps, run, bot } = ctx;
  const { name, executionId, nextApprovedTool } = request;
  let { args } = request;
  // A bot that archived itself only finishes its reply; retrying its own archive still reconciles.
  if ((ctx.state.selfArchived || bot.archivedAt) && !archivesItself(bot, name, args))
    return refusal("bot_archived", "You are archived, so no more tools can run. Send your reply.");
  if (
    (SCHEDULE_TOOL_NAMES.has(name) || SKILL_TOOL_NAMES.has(name) || name === "remove_mcp_server") &&
    (ctx.source.messagingChannelRun ||
      (await deps.prisma.steeringMessage.findFirst({
        where: {
          runId: ctx.runId,
          claimedAt: { not: null },
          message: { blocks: { array_contains: [{ kind: "channel_message" }] } },
        },
        select: { id: true },
      })))
  ) {
    return refusal(
      "shared_channel_tool_unavailable",
      "This tool is unavailable after a shared-channel message.",
    );
  }
  // Before the gate, so a run that may never reach the user's computer shows no approval card.
  if (USER_COMPUTER_TOOLS.has(name) || name === "user_computer_list") {
    if (!ctx.source.userComputerOwner || !deps.userDevices)
      return refusal(
        "user_computer_unavailable",
        "The user's computer is not available in this run.",
      );
    if (isSubagentToolExecution(executionId))
      return refusal("helper_user_computer", "Helpers cannot use the user's computer.");
    // Turning the switch off or editing the routine mid-run ends its use of the computer.
    if (
      ctx.source.ownerComputerRoutine &&
      !(await routineRunUsesOwnerComputer(deps.prisma, ctx.run))
    )
      return refusal(
        "user_computer_unavailable",
        "The user's computer is not available in this run.",
      );
    // Routines and webhooks reach no one's computer, including through a run they were handed to.
    if (
      await deps.prisma.steeringMessage.findFirst({
        where: {
          runId: ctx.runId,
          claimedAt: { not: null },
          originTrigger: { in: ["routine", "webhook"] },
        },
        select: { id: true },
      })
    )
      return refusal(
        "user_computer_unavailable",
        "The user's computer is not available in this run.",
      );
  }
  // The card shows and the effect stores the events in their short form, so padding can't hide one.
  if ((name === "schedule_create" || name === "schedule_update") && "on" in args) {
    const events = canonicalToolEvents(args.on);
    if ("error" in events) return refusal("schedule_events_invalid", events.error);
    if (events.on) args = { ...args, on: events.on };
  }
  // Before the gate, so a routine that cannot be saved shows no approval card. An approved
  // replay goes on to the handler, which checks again.
  if (name === "schedule_create" && nextApprovedTool !== name) {
    const refused = await scheduleCreateRefusal(ctx, args);
    if (refused) return refusal("schedule_create_refused", refused.error);
  }
  // A bot passing its own id is working on its own routines, which need no bot management. A
  // name may be shared, so it goes through the lookup below.
  if (reachesManagedRoutines(name, args) && String(args.bot_id ?? "").trim() === bot.id) {
    const { bot_id: _id, bot_name: _name, ...rest } = args;
    args = rest;
  }
  const managedRoutines = reachesManagedRoutines(name, args);
  const fleetWrite =
    FLEET_WRITE_TOOL_NAMES_SET.has(name) ||
    name === "archive_bot" ||
    (name === "update_bot" && argumentGiven(args.bot_id)) ||
    (managedRoutines && name !== "schedule_list");
  if (fleetWrite || name === "list_fleet" || managedRoutines) {
    if (isSubagentToolExecution(executionId))
      return refusal("helper_bot_management", "Helpers cannot use bot management tools.");
    // The run-start snapshot is not enough: the owner can turn the switch off mid-run.
    const live = await deps.prisma.bot.findUnique({
      where: { id: bot.id },
      select: { fleetManagement: true },
    });
    if (!live?.fleetManagement)
      return refusal(
        "tool_disabled",
        managedRoutines
          ? "Bot management is off for this bot, so it reaches only its own routines."
          : "This tool is disabled for this bot.",
      );
    const unattended = !ctx.source.ownerStartedRun && approvalCardExpires(run.trigger);
    if (!ctx.source.ownerStartedRun && !unattended)
      return refusal("run_not_owner_started", "Bot management tools need a run you started.");
    // Text from a channel or webhook, or whatever started a run nobody is watching, may have asked
    // for it, so it goes through the approval mode, and an Always allow rule saved for calls the
    // owner asked for does not skip it.
    // Reading another bot's instructions or routine prompts waits too: a run nobody is watching
    // may answer a bot from another Space.
    const readsPrivateText =
      unattended &&
      ((name === "list_fleet" && argumentGiven(args.bot_id)) || name === "schedule_list");
    if (
      readsPrivateText ||
      (fleetWrite && (unattended || (await ctx.trust.receivedOutsideMessage())))
    ) {
      request.heldForApproval = true;
      request.ignoresAllowRules = true;
    }
    // The card names the bot, and an approved replay acts on its id, not a name another bot
    // could take by then.
    if (managedRoutines && nextApprovedTool !== name) {
      const target = await resolveBot(deps.prisma, ctx.fleetRun, args);
      if ("error" in target) return refusal("bot_management_request_invalid", target.error);
      const { bot_id: _id, bot_name: _name, ...rest } = args;
      args = target.id === bot.id ? rest : { ...rest, bot_id: target.id, bot_name: target.name };
    }
  }
  // Only a persisted approval may supply the before-values the save checks against.
  if (name === "schedule_update" && nextApprovedTool !== name) {
    const { expected: _modelExpected, ...given } = args;
    args = given;
  }
  if (name === "update_bot" && argumentGiven(args.bot_id)) {
    // An approved replay runs the stored request, whose settings were checked before the card.
    if (nextApprovedTool === name) request.heldForApproval = args.settings !== undefined;
    else {
      const { settings: _stored, ...given } = args;
      args = given;
      if (childSettingsGiven(given)) {
        const prepared = await prepareChildBotUpdate(
          {
            ...(await fleetPrepareDeps(deps, run)),
            listVoices: () => listDefaultVoices(deps, run, ctx.context),
          },
          ctx.fleetRun,
          given,
          ctx.secrets,
        );
        if ("error" in prepared) return refusal("bot_management_request_invalid", prepared.error);
        args = prepared.canonical;
        // A call that repeats every setting is only a profile edit, which needs no card.
        if (args.settings !== undefined) {
          request.fleetSummary = prepared.summary;
          request.heldForApproval = true;
        }
      }
    }
  }
  if (name === "update_preferences") request.settingsChange = true;
  if (name === "save_page") {
    const refused = await holdSharedPageSave(ctx, request);
    if (refused) return refused;
    args = request.args;
  }
  if (name === "update_bot" && !argumentGiven(args.bot_id)) {
    const refused = await prepareOwnBotUpdate(ctx, request);
    if (refused) return refused;
    args = request.args;
  }
  if (isFleetApprovalTool(name) && nextApprovedTool !== name) {
    // Resolve names, members, model and schedule now; an approved replay runs the stored
    // request above and never resolves them again.
    const prepared = await prepareFleetRequest(
      await fleetPrepareDeps(deps, run),
      ctx.fleetRun,
      name,
      args,
      ctx.secrets,
    );
    if (!prepared.ok) return refusal("bot_management_request_invalid", prepared.error);
    args = prepared.canonical;
    request.fleetSummary = prepared.summary;
  }
  if (name === "respond_agent_connection") {
    if (nextApprovedTool !== name) {
      const pending = await prepareAgentConnectionResponse(
        deps.prisma,
        bot.id,
        Boolean(args.accept),
      );
      if (!pending)
        return refusal("no_pending_connection_request", "no pending connection request");
      args = pending;
    } else if (
      typeof args.requester_name !== "string" ||
      typeof args.requester_address !== "string" ||
      typeof args.requester_provider !== "string"
    ) {
      return refusal("connection_request_not_pending", "connection request is no longer pending");
    }
  }
  if (PURCHASE_CHECKED_TOOLS.has(name)) {
    // The approval is written here from what the page says; a model-supplied one is dropped, and an
    // approved replay keeps the one the user saw.
    const {
      purchaseApproval: given,
      cardApproval: givenCard,
      loginApproval: givenLogin,
      ...rest
    } = args;
    const approved = nextApprovedTool === name ? purchaseApprovalOf(given) : undefined;
    args = approved ? { ...rest, purchaseApproval: given } : rest;
    // A saved card is typed only into the checkout a person approved: the approval names the card
    // and the site, and a replay keeps the one the user saw.
    const wantedCard = name === "browser_act" ? requestedCardUse(rest.actions) : undefined;
    if (wantedCard && "error" in wantedCard) return wantedCard;
    if (wantedCard) {
      const approvedCard = nextApprovedTool === name ? vaultCardUseOf(givenCard) : undefined;
      if (
        approvedCard &&
        (approvedCard.card !== wantedCard.card || approvedCard.site !== wantedCard.site)
      )
        return refusal(
          "card_not_approved",
          "This types a saved card the user has not approved, so nothing was typed. Call the tool again with only that card; that asks the user.",
        );
      let cardUse = approvedCard;
      if (!cardUse) {
        const [item] = await listVaultItems(deps.prisma, deps.secretStore, run, wantedCard.card);
        if (BotSecretAuth.safeParse(item?.auth).data?.type !== "card")
          return refusal("card_not_found", "No card is saved under this name. Check list_secrets.");
        cardUse = { ...wantedCard, title: item!.title, savedAt: item!.updatedAt.toISOString() };
      }
      args = { ...args, cardApproval: cardUse };
      request.cardUse = cardUse;
      request.fleetSummary = cardUseSummary(cardUse);
    }
    const loginUse =
      name === "browser_act"
        ? await askingLoginUse(ctx, rest.actions, nextApprovedTool === name, givenLogin)
        : undefined;
    if (loginUse && "error" in loginUse) return loginUse;
    if (loginUse && request.cardUse)
      return {
        error: "Type a saved card and sign in with a saved login in separate browser_act calls.",
      };
    // A desktop press has no check on the page right before it, as a browser_act click does: one the user
    // approved goes ahead only while the page still shows what the card did.
    if (name === "computer_act" && approved) {
      const now = await detectPurchase(ctx, name, rest);
      if (typeof now === "string") return uncheckedPress(now);
      if (
        !now ||
        now.site !== approved.site ||
        now.label !== approved.label ||
        now.amount === "?" ||
        now.total === "?" ||
        now.amount !== approved.amount ||
        (now.total ?? "") !== (approved.total ?? "")
      )
        return refusal(
          "purchase_page_changed",
          "The page changed since the user approved this purchase, so nothing was pressed. Look at the screen and try again.",
        );
    }
    const detected = approved ?? (await detectPurchase(ctx, name, rest));
    // A press that could not be checked is never pressed and never asked about, in any approval mode.
    if (typeof detected === "string") return uncheckedPress(detected);
    const purchase = detected;
    // One card asks one question: a sign-in is never approved under a payment's.
    if (loginUse && purchase)
      return {
        error: "Sign in with a saved login and complete a purchase in separate browser_act calls.",
      };
    if (loginUse) {
      args = { ...args, loginApproval: loginUse };
      request.loginUse = loginUse;
      request.fleetSummary = loginUseSummary(loginUse);
    }
    // An approval given for something else never covers a purchase: the call is made again and asks.
    if (purchase && !approved && nextApprovedTool === name)
      return refusal(
        "purchase_not_approved",
        "This would complete a purchase, which the user has not approved, so nothing was pressed. Call the tool again with only that step; that asks the user.",
      );
    if (purchase) {
      args = { ...args, purchaseApproval: purchase };
      // The person approved paying at a site this run typed the approved card or pay token into: the
      // click still carries the approval to the page, with no card. Spent on the first purchase click there.
      if (approved || request.cardUse || !ctx.state.walletHosts.delete(purchase.site)) {
        request.purchase = purchase;
        request.fleetSummary = request.cardUse
          ? cardUseSummary(request.cardUse, purchase)
          : purchaseCardSummary(purchase);
      }
    }
    if (
      purchase ||
      request.cardUse ||
      request.loginUse ||
      given !== undefined ||
      givenCard !== undefined ||
      givenLogin !== undefined
    )
      request.effectRequest = args;
  }
  request.args = args;
  if (
    name === "respond_agent_connection" ||
    name === "update_bot" ||
    name === "schedule_create" ||
    name === "schedule_update" ||
    isFleetApprovalTool(name)
  )
    request.effectRequest = args;
  return undefined;
}

/** Prepare the review and persist its before-values only in the request replayed after approval. */
export async function prepareScheduleUpdateApproval(ctx: RunContext, request: ToolRequest) {
  const prepared = await scheduleUpdatePreview(ctx, request.args);
  if ("error" in prepared) return refusal("schedule_update_refused", prepared.error);
  request.fleetSummary = prepared.summary;
  if (prepared.pinned) request.effectRequest = { ...request.args, expected: prepared.pinned };
}

/** What the model is told when a press could not be checked for a payment, so nothing was pressed. */
function uncheckedPress(why: UncheckedPress): { error: string } {
  switch (why) {
    case "opened":
      return refusal(
        "purchase_page_opened",
        "This presses on a page the same call opens, which couldn't be checked first, so nothing was pressed. Open the page first, then press in a separate call.",
      );
    case "dialog":
      return refusal(
        "purchase_dialog_unchecked",
        "A confirmation dialog is open and couldn't be checked for a payment, so nothing was pressed. Press Escape to cancel it, or stop and ask the user.",
      );
    case "dialog-batch":
      return refusal(
        "purchase_dialog_batch",
        "A dialog is open on the page, so nothing was pressed. Answer it with a single press in its own call, then continue.",
      );
    case "unreadable":
      return refusal(
        "purchase_page_unreadable",
        "The page couldn't be read, so nothing was pressed. Reload the page or take a screenshot and try once more; if it still can't be read, stop and tell the user.",
      );
  }
}

/**
 * Settings that change what this bot runs on, how it speaks or how it works; only the owner's chat
 * sets them, and Auto Review checks them after outside content.
 */
const OWNER_SETTINGS = ["model", "thinkingLevel", "voice", "readAloud", ...BOT_SETTING_ARGS];

/**
 * Everything a bot may change on itself. Credentials, access, approvals and turning tools back
 * on stay in Settings.
 */
const OWN_FIELDS = new Set([
  ...OWNER_SETTINGS,
  "name",
  "description",
  "instructions",
  "instructions_offset",
  "instructionsOffset",
  "color",
  "artifact_id",
  "use_attached_image",
  "notifyOnFinish",
  "dailyCheckIns",
  "notify_on_finish",
  "bot_id",
]);

/**
 * Every way an own update_bot call can name the model this bot runs on now: its id,
 * provider/id, and the label update_bot's read shows. A bot without its own model runs on the
 * space default, read fresh rather than from this run, which may record an earlier attempt.
 */
async function currentModelNames(
  ctx: RunContext,
  bot: { modelProvider: string | null; modelId: string | null },
): Promise<string[]> {
  const pinned = Boolean(bot.modelProvider && bot.modelId);
  const { provider, model } = pinned
    ? { provider: bot.modelProvider, model: bot.modelId }
    : await (await fleetPrepareDeps(ctx.deps, ctx.run)).modelChange.defaultModel();
  if (!provider || !model) return pinned ? [] : ["default"];
  const label = modelLabel(provider, model);
  return [
    model,
    `${provider}/${model}`,
    label,
    ...(pinned ? [] : ["default", `${label} (default)`]),
  ];
}

/**
 * `update_bot` on this bot itself. Under Never ask instructions are written at once; otherwise
 * they go through approval like any other action, and runs someone else started cannot change
 * them, except a run nobody is watching, whose owner answers its card.
 */
async function prepareOwnBotUpdate(
  ctx: RunContext,
  request: ToolRequest,
): Promise<PrepareRefusal | undefined> {
  const { run } = ctx;
  const { executionId, nextApprovedTool } = request;
  if (nextApprovedTool === "update_bot") {
    // The approved replay runs the stored request.
    request.heldForApproval = typeof request.args.previousInstructions === "string";
    return undefined;
  }
  const { previousInstructions: _previous, reason: _reason, ...given } = request.args;
  const current = await ctx.deps.prisma.bot.findUnique({
    where: { id: run.botId },
    select: {
      name: true,
      description: true,
      instructions: true,
      color: true,
      notifyOnFinish: true,
      dailyCheckIns: true,
      modelProvider: true,
      modelId: true,
      thinkingLevel: true,
      autoSpeak: true,
      voiceId: true,
      replyMode: true,
      teamChatAmbientEnabled: true,
      teamChatRules: true,
      memoryScope: true,
      disabledBuiltinTools: true,
    },
  });
  const args = current
    ? dropUnchangedOwnBotArgs(
        given,
        current,
        argumentGiven(given.model) ? await currentModelNames(ctx, current) : [],
        current.thinkingLevel ? undefined : run.thinkingLevel,
      )
    : given;
  request.args = args;
  // A paged read never writes: the handler answers with the settings and names every other field
  // it left out, so the write checks below do not apply to those fields.
  if (argumentGiven(args.instructions_offset ?? args.instructionsOffset)) return undefined;
  const settingsOnly = Object.keys(args).filter(
    (key) => !OWN_FIELDS.has(key) && argumentGiven(args[key]),
  );
  if (settingsOnly.length)
    return refusal(
      "owner_only_settings",
      `Only the owner can change ${settingsOnly.join(", ")}, in Settings.`,
    );
  if (
    typeof args.teamChatRules === "string" &&
    redactSecrets(args.teamChatRules, ctx.secrets) !== args.teamChatRules
  )
    return refusal(
      "team_chat_rules_contain_credentials",
      "teamChatRules cannot contain credentials.",
    );
  // Shared memory widens what this bot reads, so only the owner grants it.
  if (args.memoryScope === "shared")
    return refusal("owner_only_settings", "Only the owner can share your memory, in Settings.");
  const unguarded = await neverAsks(ctx);
  // A run nobody is watching asks its owner on a card that expires unanswered.
  const unattended = !ctx.source.ownerStartedRun && approvalCardExpires(run.trigger);
  if (OWNER_SETTINGS.some((key) => argumentGiven(args[key]))) {
    if (
      isSubagentToolExecution(executionId) ||
      (!unguarded && !ctx.source.ownerStartedRun && !unattended)
    )
      return refusal(
        "owner_only_model_settings",
        "Only the owner can change your settings, from their own chat.",
      );
    request.settingsChange = true;
    if (unattended) {
      request.heldForApproval = true;
      request.ignoresAllowRules = true;
    }
  }
  if (!argumentGiven(args.instructions)) return undefined;
  if (isSubagentToolExecution(executionId))
    return refusal("helper_instructions", "Helpers cannot set instructions.");
  const instructions = String(args.instructions).trim();
  if (instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH)
    return refusal(
      "instructions_too_long",
      `instructions must be at most ${BOT_INSTRUCTIONS_MAX_LENGTH} characters.`,
    );
  if (redactSecrets(instructions, ctx.secrets) !== instructions)
    return refusal("instructions_contain_credentials", "Instructions cannot contain credentials.");
  request.args = { ...args, instructions };
  if (unguarded) return undefined;
  // A run someone else started acts with their authority, and its card is theirs to answer. A new
  // bot's first run sets the instructions its creator asked for, and the owner answers the card of
  // a run nobody is watching.
  if (run.trigger !== "created" && !ctx.source.ownerStartedRun && !unattended)
    return refusal(
      "instructions_run_not_owner_started",
      "Instruction changes are blocked for runs someone else started.",
    );
  if (Object.keys(args).some((key) => key !== "instructions"))
    return refusal(
      "instructions_need_own_call",
      "Change your instructions in their own update_bot call.",
    );
  // An older checkpoint predates the baseline; this attempt must not guess.
  if (ctx.state.ownInstructionsBaseline === undefined)
    return refusal("instructions_baseline_unknown", OWN_INSTRUCTIONS_BASELINE_UNKNOWN_ERROR);
  request.args = {
    instructions,
    reason: "Set in chat",
    // The text the model worked from, not a fresh read: a change that landed since the
    // attempt started conflicts at approval instead of being overwritten.
    previousInstructions: ctx.state.ownInstructionsBaseline,
    // Provenance the approved replay checks; requests stored before the baseline lack it.
    previousInstructionsFromBaseline: true,
  };
  request.heldForApproval = true;
  if (unattended) request.ignoresAllowRules = true;
  return undefined;
}
