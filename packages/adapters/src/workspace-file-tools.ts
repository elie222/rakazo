import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { JSDOM } from "jsdom";
import { displayBotWorkspacePath, resolveBotWorkspacePath } from "./computer-support.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { PlotSpec } from "./plot-tool.js";
import {
  assertPlotDataWithinLimits,
  PLOT_TOOL_GUIDE,
  parsePlotData,
  plotSvgToPng,
  renderPlotSpecToSvg,
  searchChartCatalog,
} from "./plot-tool.js";
import { publishMessage } from "./run-messages.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
/** The bot workspace a run reaches on its computer. */
export type RunWorkspace = {
  botId: string;
  computerMode: ComputerMode;
  computer: () => Promise<ComputerRef>;
  markDirty: () => void;
  context: AdapterContext;
  runSecrets: string[];
};

const MAX_MODEL_FILE_BYTES = 250_000;

export async function listFilesFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
) {
  const { botId, computerMode, computer, context, runSecrets } = workspace;
  const requestedPath = String(args.path ?? "");
  const entries = await sandbox.listFiles(
    await computer(),
    resolveBotWorkspacePath(computerMode, botId, requestedPath),
    context,
  );
  return {
    path: requestedPath,
    entries: entries.map((entry) => ({
      ...entry,
      // A file name can carry a value an earlier command or page wrote.
      path: redactSecrets(
        displayBotWorkspacePath(computerMode, botId, requestedPath, entry.path),
        runSecrets,
      ),
    })),
  };
}

export async function readFileFromTool(
  sandbox: SandboxProvider,
  workspace: RunWorkspace,
  args: Record<string, unknown>,
) {
  const { botId, computerMode, computer, context, runSecrets } = workspace;
  const filePath = String(args.path ?? "");
  const storedPath = resolveBotWorkspacePath(computerMode, botId, filePath);
  let bytes: Uint8Array;
  try {
    bytes = await sandbox.readFile(await computer(), storedPath, context, {
      maxBytes: MAX_MODEL_FILE_BYTES,
    });
  } catch (error) {
    if (error instanceof Error && /exceeds \d+ bytes/.test(error.message)) {
      return {
        error: "file is too large for model context",
        path: filePath,
      };
    }
    throw error;
  }
  if (bytes.byteLength > MAX_MODEL_FILE_BYTES) {
    return {
      error: "file is too large for model context",
      path: filePath,
      size: bytes.byteLength,
    };
  }
  try {
    return {
      path: filePath,
      content: redactSecrets(new TextDecoder("utf-8", { fatal: true }).decode(bytes), runSecrets),
    };
  } catch {
    return {
      error: "file is not UTF-8 text; use open_path to inspect it",
      path: filePath,
    };
  }
}

/** render_plot: returns the chart guide or catalog, or renders a chart into the workspace and chat. */
export async function renderPlotFromTool(
  deps: ExecutorDeps,
  run: {
    id: string;
    spaceId: string;
    userId: string;
    threadId: string;
    botId: string;
    trigger: string;
  },
  args: Record<string, unknown>,
  executionId: string,
  workspace: RunWorkspace,
  finish: (result: unknown) => Promise<unknown>,
) {
  const { botId, computerMode, computer, context, runSecrets } = workspace;
  if (args.charts !== undefined) {
    const query = typeof args.charts === "string" ? args.charts : undefined;
    return {
      charts: searchChartCatalog(query),
      note: "Each spec is a complete runnable example: substitute your rows and column names, then call render_plot with it.",
    };
  }
  if (args.help === true || !args.spec || typeof args.spec !== "object") {
    return { guide: PLOT_TOOL_GUIDE };
  }
  // Data and spec mistakes are the model's to fix from the returned error;
  // everything else (reading the data file, rasterizing, attaching) is ours.
  let checkingSpec = false;
  try {
    let rows = Array.isArray(args.data) ? (args.data as unknown[]) : undefined;
    const dataPath =
      typeof args.data_path === "string" && args.data_path ? args.data_path : undefined;
    if (!rows && dataPath) {
      const bytes = await deps.sandbox.readFile(
        await computer(),
        resolveBotWorkspacePath(computerMode, botId, dataPath),
        context,
        { maxBytes: deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES },
      );
      checkingSpec = true;
      rows = parsePlotData(dataPath, new TextDecoder().decode(bytes));
    }
    checkingSpec = true;
    assertPlotDataWithinLimits(args.spec as PlotSpec, rows);
    const svg = renderPlotSpecToSvg(args.spec as PlotSpec, rows, new JSDOM("").window.document);
    checkingSpec = false;
    const png = await plotSvgToPng(svg);
    const outPath =
      typeof args.path === "string" && args.path ? args.path : `charts/plot-${Date.now()}.png`;
    workspace.markDirty();
    await deps.sandbox.writeFile(
      await computer(),
      {
        path: resolveBotWorkspacePath(computerMode, botId, outPath),
        content: png,
      },
      context,
    );
    let attached = false;
    const chartName = outPath.split("/").pop() ?? "chart";
    const chartRows = rows ?? (args.spec as { data?: unknown[] }).data ?? [];
    const chartSpec = { ...(args.spec as Record<string, unknown>) };
    delete chartSpec.data;
    const chartFits =
      Array.isArray(chartRows) &&
      JSON.stringify({ spec: chartSpec, data: chartRows }).length <= 200_000;
    if (args.attach !== false && chartFits) {
      // Live inline chart: the client re-renders the validated spec
      // and the PNG stays on disk as the exportable copy.
      await publishMessage(deps, run, "bot", [
        {
          kind: "chart",
          name: chartName,
          spec: chartSpec,
          data: chartRows,
        },
      ]);
      attached = true;
    } else if (args.attach !== false && deps.artifacts) {
      const result = await attachWorkspaceFileToThread(
        {
          prisma: deps.prisma,
          artifacts: deps.artifacts,
          maxUploadSizeBytes: deps.maxUploadSizeBytes,
        },
        {
          spaceId: run.spaceId,
          userId: run.userId,
          botId,
          runId: run.id,
          filePath: outPath,
          bytes: png,
          operationId: executionId,
        },
      );
      await publishMessage(deps, run, "bot", [result.block]);
      attached = true;
    }
    return finish({ ok: true, path: outPath, attached });
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
      runSecrets,
    );
    if (!checkingSpec) getLogger().error(`render_plot failed for bot ${botId}: ${message}`);
    return finish({
      error: message,
      hint: 'Call render_plot with {"charts": true} for runnable example specs, or {"help": true} for the full guide.',
    });
  }
}
