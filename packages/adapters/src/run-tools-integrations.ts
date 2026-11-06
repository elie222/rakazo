import type { ConnectorApp } from "@rakazo/adapter-kit";
import { isBackgroundRunTrigger, redactSecrets } from "@rakazo/core";
import { normalizedHttpUrl } from "@rakazo/core/egress";
import { getLogger } from "@rakazo/logging";
import { executeCloudAgentTool } from "./cloud-agent-service.js";
import { collectLogIds } from "./composio-connector.js";
import { connectApp } from "./connect-app.js";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";
import { mcpAppViewArguments, mcpAppViewResult } from "./mcp-app.js";
import { addMcpServerFromTool } from "./mcp-server-tool.js";
import type { RunContext } from "./run-context.js";
import { addRunSecrets } from "./run-context.js";
import { runScopedToolExecutionId } from "./run-effects.js";
import { publishMessage } from "./run-messages.js";
import { flushProgress, publishMidTurnNarration, showNarrationStatus } from "./run-progress.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { storeMcpAppHtml } from "./thread-artifacts.js";
import { restoreToolFilePlaceholders, substituteToolFilePlaceholders } from "./tool-file-args.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

export async function cloudAgentTool(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, context } = ctx;
  const { name, args, effectKey } = call;
  return call.finish(
    await executeCloudAgentTool(
      { ...deps, cloudAgent: ctx.providers.cloudAgent },
      { ...context, operationId: effectKey, botId: bot.id },
      run,
      name,
      args,
    ),
  );
}

export async function connectorTool(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, thread, context } = ctx;
  const { name, args, effectKey, connectorCall } = call;
  if (deps.connector) {
    let result: unknown = { error: `unknown tool ${name}` };
    // Files named by placeholder are filled in here, after approval, in a copy only the tool
    // sees: the effect, approval and audit keep the placeholders.
    // `{{file_path:ID}}` is left for the MCP connector, which writes the copy where its
    // local server can read it; other connectors refuse it.
    const prepared = await substituteToolFilePlaceholders(
      args,
      deps.toolFiles,
      { spaceId: run.spaceId, userId: run.userId, botId: bot.id },
      { allowPaths: connectorCall.route?.connectorId === "mcp" },
    );
    if (!prepared.ok) return call.finish({ error: prepared.error });
    const { substitutions } = prepared;
    // Signed URLs are short, so the run hides them everywhere it shows or stores text. File
    // content can be megabytes, too long for the streaming redactor, so wherever the tool
    // echoes it (or a URL) the placeholder is put back instead.
    const urls = substitutions.filter((entry) => entry.form === "url").map((entry) => entry.value);
    if (urls.length > 0) addRunSecrets(ctx, urls);
    const restore = <T>(value: T): T => restoreToolFilePlaceholders(value, substitutions);
    // Background work posts no cards, so it does not fetch the app either.
    const withApp = Boolean(deps.artifacts) && !isBackgroundRunTrigger(run.trigger);
    for await (const event of deps.connector.execute(
      { ...connectorCall, tool: name, args: prepared.args, executionId: effectKey, withApp },
      context,
    )) {
      if (event.type === "app") {
        await showConnectorApp(ctx, call, { ...event.app, html: restore(event.app.html) }, result);
        continue;
      }
      if (event.type === "result") {
        result = restore(event.data);
        const logIds = collectLogIds(result);
        for (const logId of logIds) {
          await deps.events.append({
            spaceId: run.spaceId,
            threadId: thread.id,
            botId: bot.id,
            runId: run.id,
            type: "effect.recorded",
            payload: { tool: name, logId },
          });
        }
      }
      if (event.type === "error") {
        result = { error: restore(event.message) };
        for (const logId of event.logIds ?? []) {
          await deps.events.append({
            spaceId: run.spaceId,
            threadId: thread.id,
            botId: bot.id,
            runId: run.id,
            type: "effect.recorded",
            payload: { tool: name, logId },
          });
        }
      }
    }
    return call.finish(result);
  }
  return call.finish({ error: `unknown tool ${name}` });
}

/**
 * Posts an MCP server's app for this call as a card above the bot's reply. The card is extra:
 * storing or posting it failing leaves the call's result, which the bot already has, as it is.
 */
async function showConnectorApp(
  ctx: RunContext,
  call: ToolCall,
  app: ConnectorApp,
  result: unknown,
): Promise<void> {
  const { deps, run, bot, thread } = ctx;
  if (!deps.artifacts) return;
  try {
    const artifactId = await storeMcpAppHtml(
      { prisma: deps.prisma, artifacts: deps.artifacts },
      {
        spaceId: run.spaceId,
        userId: run.userId,
        botId: bot.id,
        groupId: thread.groupId ?? undefined,
        runId: run.id,
        server: app.server,
        html: redactSecrets(app.html, ctx.secrets),
        operationId: `${call.effectKey}:app`,
      },
    );
    await publishMessage(deps, run, "bot", [
      {
        kind: "app",
        artifactId,
        server: app.server.slice(0, 200),
        tool: (call.connectorCall.route?.toolName ?? call.name).slice(0, 200),
        // Secrets revealed earlier in the run stay out of the card, as they do from replies.
        toolArguments: mcpAppViewArguments(
          redactConnectorPayload(call.args, ctx.secrets) as Record<string, unknown>,
        ),
        toolResult: mcpAppViewResult(redactConnectorPayload(result, ctx.secrets)),
        ...(app.csp.connectDomains || app.csp.resourceDomains ? { csp: app.csp } : {}),
        ...(app.prefersBorder !== undefined ? { prefersBorder: app.prefersBorder } : {}),
      },
    ]);
  } catch (error) {
    getLogger().warn("mcp_app.card_failed", {
      "tool.name": call.name,
      error: sanitizeConnectorError(error),
    });
  }
}

/** Web, cloud agents, MCP servers, app connections and connector tools. */
export const integrationTools: ToolHandlers = {
  async web_search(ctx, call) {
    const { context } = ctx;
    const { args } = call;
    const found = await webSearchFromTool(ctx.providers.web, context, args);
    // A result's exact URL was chosen by the search index, not by text in this run.
    for (const hit of ("results" in found && found.results) || []) {
      const url = normalizedHttpUrl(hit.url);
      if (url) ctx.trust.searchResultUrls.add(url);
    }
    return call.finish(found);
  },
  async web_fetch(ctx, call) {
    const { context } = ctx;
    const { args } = call;
    return call.finish(await webFetchFromTool(ctx.providers.web, context, args));
  },
  async add_mcp_server(ctx, call) {
    const { deps, run, bot } = ctx;
    const { args, executionId } = call;
    return call.finish(await addMcpServerFromTool(deps, run, bot.id, args, executionId));
  },
  async connect_app(ctx, call) {
    const { deps, run, runId, context } = ctx;
    const { args, executionId, applied } = call;
    await flushProgress(ctx);
    await showNarrationStatus(ctx, await publishMidTurnNarration(ctx, true));
    return call.finish(
      await connectApp(
        deps,
        deps.connectors?.managedProviders?.() ?? [],
        context,
        run,
        args.app,
        applied?.effect.id ?? runScopedToolExecutionId(runId, executionId),
      ),
    );
  },
};
