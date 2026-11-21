import type { CodingCliConnection } from "../../cli-models/coding-cli-factory.js";
import { resolveBotWorkspaceCwd } from "../../computers/screens/computer-support.js";
import type { ToolHandlers } from "./run-tool-gate.js";

export const codingCliTools: ToolHandlers = {
  async coding_cli_run(ctx, call) {
    const { deps, bot, context } = ctx;
    const connection = deps.codingCli;
    if (!connection) return call.finish({ error: "The coding CLI is not configured." });
    const cwd = resolveBotWorkspaceCwd(ctx.computer.mode, bot.id, undefined);
    return call.finish(
      await connection.execute(
        async function* (request) {
          ctx.computer.checkpoint.markDirty();
          const computer = await ctx.computer.get("tool", call.name);
          yield* deps.sandbox.execute(computer, request, context);
        },
        {
          prompt: call.args.prompt,
          model: call.args.model,
          resume: call.args.resume,
          enabled: true,
          apiKey: connection.apiKey,
          bin: connection.command,
          cwd,
          secrets: ctx.secrets,
        },
      ),
    );
  },
};

export function codingCliConfigured(connection: CodingCliConnection | null | undefined): boolean {
  return Boolean(connection);
}
