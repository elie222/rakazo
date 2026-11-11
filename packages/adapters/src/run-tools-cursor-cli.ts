import { resolveBotWorkspaceCwd } from "./computer-support.js";
import { executeCursorCli } from "./cursor-cli.js";
import type { ToolHandlers } from "./run-tool-gate.js";

export const cursorCliTools: ToolHandlers = {
  async cursor_agent(ctx, call) {
    const { deps, bot, context } = ctx;
    const cwd = resolveBotWorkspaceCwd(ctx.computer.mode, bot.id, undefined);
    return call.finish(
      await executeCursorCli(
        async function* (request) {
          ctx.computer.checkpoint.markDirty();
          const computer = await ctx.computer.get("tool", call.name);
          yield* deps.sandbox.execute(computer, request, context);
        },
        {
          prompt: call.args.prompt,
          model: call.args.model,
          resume: call.args.resume,
          enabled: Boolean(deps.cursorCliEnabled),
          apiKey: deps.cursorApiKey,
          bin: deps.cursorCliBin ?? "agent",
          cwd,
          secrets: ctx.secrets,
        },
      ),
    );
  },
};
