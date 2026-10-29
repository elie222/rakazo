import type { ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { reserveInstructionProposal, validateInstructionProposal } from "@rakazo/db";
import { prepareAgentConnectionResponse } from "./agent-connections.js";
import type { FleetCardSummary } from "./approval-ask.js";
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
} from "./approval-effect.js";
import { validCloudAgentArgs } from "./cloud-agent-tools.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { isFleetApprovalTool, prepareFleetRequest } from "./fleet-tools.js";
import { assertConnectorToolArgs, CATALOG_EXECUTE } from "./lazy-tool-catalog.js";
import { paidRequestEffect, restorePaidRequest } from "./paid-request.js";
import type { RunContext } from "./run-context.js";
import {
  approvalReplayEffectToolName,
  CATALOG_APPROVAL_TOOL,
  isSubagentToolExecution,
} from "./run-effects.js";
import { fleetPrepareDeps } from "./run-model.js";
import { BUILTIN_AGENT_TOOL_NAMES, FLEET_WRITE_TOOL_NAMES_SET } from "./run-tool-selection.js";
import { USER_COMPUTER_SHELL_TOOL } from "./run-tools-user-computer.js";
import { argumentGiven } from "./update-bot-patch.js";

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
}

type ToolError = { error: string };

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
    return {
      error: "Invalid cloud agent arguments. Raw environment variables are not supported.",
    };
  }
  let effectRequest: unknown = name === "paid_request" ? paidRequestEffect(args) : args;
  if (connectorCall.route && deps.connector?.resolveCall) {
    try {
      const resolved = await deps.connector.resolveCall(connectorCall, context);
      if (resolved) {
        if (BUILTIN_AGENT_TOOL_NAMES.has(resolved.tool.name)) {
          return {
            error: "Connector tool name conflicts with a built-in tool",
          };
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
                toolName: resolved.tool.route.toolName,
              }
            : undefined,
        );
        connectorCall = resolved.call;
      }
    } catch (error) {
      return { error: sanitizeConnectorError(error) };
    }
  }
  if (approvedReplay.args && !catalogRemapped) {
    return {
      error:
        "Approved catalog request could not be resolved to a tool. Deny and retry the direct tool call.",
    };
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
    return {
      error: `Approved request ${nextApprovedTool} must be replayed before ${name}.`,
    };
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
        return {
          error: `Approved catalog request ${name} is missing tool arguments.`,
        };
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
  };
}

/**
 * Check bot-management and instruction-proposal preconditions, and canonicalize the
 * requests whose approval card shows resolved names. Updates the request in place.
 */
// Runs whose prompt someone other than the owner wrote; their text stays in the chat's history.
const OUTSIDE_RUN_TRIGGERS = [
  "webhook",
  "messaging",
  "bot_message",
  "spawn",
  "cloud_agent",
  "tickets",
];

/** Earlier outside text in the chat can steer this run even when the run itself took in none. */
async function threadHasOutsideHistory(
  prisma: RunContext["deps"]["prisma"],
  threadId: string,
  botId: string,
): Promise<boolean> {
  const [message, run] = await Promise.all([
    prisma.message.findFirst({
      where: {
        threadId,
        OR: [
          { role: "bot", botId: { not: botId } },
          { blocks: { array_contains: [{ kind: "channel_message" }] } },
          { blocks: { array_contains: [{ kind: "bot_message_received" }] } },
        ],
      },
      select: { id: true },
    }),
    prisma.run.findFirst({
      where: { threadId, trigger: { in: OUTSIDE_RUN_TRIGGERS } },
      select: { id: true },
    }),
  ]);
  return Boolean(message || run);
}

export async function prepareToolRequest(
  ctx: RunContext,
  request: ToolRequest,
): Promise<ToolError | undefined> {
  const { deps, run, runId, bot } = ctx;
  const { name, executionId, nextApprovedTool } = request;
  let { args } = request;
  // Before the gate, so a run that may never reach the user's computer shows no approval card.
  if (name === USER_COMPUTER_SHELL_TOOL) {
    if (!ctx.source.userComputerOwner || !deps.userDevices)
      return { error: "The user's computer is not available in this run." };
    if (isSubagentToolExecution(executionId))
      return { error: "Helpers cannot use the user's computer." };
  }
  const fleetWrite =
    FLEET_WRITE_TOOL_NAMES_SET.has(name) ||
    name === "archive_bot" ||
    (name === "update_bot" && argumentGiven(args.bot_id));
  if (fleetWrite || name === "list_fleet") {
    if (isSubagentToolExecution(executionId))
      return { error: "Helpers cannot use bot management tools." };
    // The run-start snapshot is not enough: the owner can turn the switch off mid-run.
    const live = await deps.prisma.bot.findUnique({
      where: { id: bot.id },
      select: { fleetManagement: true },
    });
    if (!live?.fleetManagement) return { error: "This tool is disabled for this bot." };
    if (!ctx.source.ownerStartedRun)
      return { error: "Bot management tools need a run you started." };
    if (fleetWrite && (await ctx.trust.receivedOutsideMessage()))
      return {
        error:
          "Changes to the bots you manage are blocked for the rest of this run because it received a channel or webhook message.",
      };
  }
  if (name === "update_bot" && !argumentGiven(args.bot_id) && argumentGiven(args.instructions)) {
    if (isSubagentToolExecution(executionId)) return { error: "Helpers cannot set instructions." };
    // Only the owner's own words may become instructions unseen: no outside message, and no
    // outside tool result in this attempt's context, restored or new. The creation intro has
    // no tools that read outside content, and answering its question clears the checkpoint.
    const ownWords =
      !(await ctx.trust.receivedOutsideMessage()) &&
      (run.trigger === "created" || (ctx.source.ownerStartedRun && !ctx.state.tainted)) &&
      !(await threadHasOutsideHistory(deps.prisma, run.threadId, bot.id));
    if (!ownWords) return { error: "Propose your instructions with propose_instructions_update." };
    if (redactSecrets(String(args.instructions), ctx.secrets) !== args.instructions)
      return { error: "Instructions cannot contain credentials." };
  }
  if (name === "propose_instructions_update") {
    try {
      if (run.trigger === "follow_up" && !ctx.source.ownerStartedRun)
        return {
          error: "Instruction updates are blocked for externally triggered runs.",
        };
      if (!nextApprovedTool) validateInstructionProposal(args, run.trigger);
      else
        validateInstructionProposal(
          { instructions: args.instructions, reason: args.reason },
          run.trigger,
        );
      if (
        redactSecrets(String(args.instructions), ctx.secrets) !== args.instructions ||
        redactSecrets(String(args.reason), ctx.secrets) !== args.reason
      )
        return { error: "Instruction proposals cannot contain credentials." };
      const instructionProposalBot = await reserveInstructionProposal(deps.prisma, bot.id, runId);
      if (!nextApprovedTool) {
        args = { ...args, previousInstructions: instructionProposalBot.instructions };
      }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Invalid instruction proposal.",
      };
    }
  }
  if (isFleetApprovalTool(name) && nextApprovedTool !== name) {
    // Resolve names, members, model and schedule now; an approved replay runs the stored
    // request above and never resolves them again.
    const prepared = await prepareFleetRequest(
      fleetPrepareDeps(deps, run),
      ctx.fleetRun,
      name,
      args,
      ctx.secrets,
    );
    if (!prepared.ok) return { error: prepared.error };
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
      if (!pending) return { error: "no pending connection request" };
      args = pending;
    } else if (
      typeof args.requester_name !== "string" ||
      typeof args.requester_address !== "string" ||
      typeof args.requester_provider !== "string"
    ) {
      return { error: "connection request is no longer pending" };
    }
  }
  request.args = args;
  if (
    name === "propose_instructions_update" ||
    name === "respond_agent_connection" ||
    isFleetApprovalTool(name)
  )
    request.effectRequest = args;
  return undefined;
}
