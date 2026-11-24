import { NativeClockOperation } from "@rakazo/contracts";
import { requestNativeCalendar } from "../personal-calendar/native-calendar.js";
import type { ToolHandler } from "../runs/tools/run-tool-gate.js";

export const phoneClockTool: ToolHandler = async (ctx, call) => {
  const operation = NativeClockOperation.safeParse({ action: call.name, input: call.args });
  if (!operation.success)
    return call.finish({ error: operation.error.issues[0]?.message ?? "Invalid clock request." });

  if (await ctx.trust.receivedOutsideMessage()) return call.finish({ status: "unavailable" });

  const result = await requestNativeCalendar(
    ctx.deps,
    ctx.run,
    { owner: ctx.workerId, fence: ctx.fence },
    operation.data,
    ctx.context.signal,
    call.effectKey,
  );

  switch (result.status) {
    case "dispatched":
      return call.finish({
        status: result.status,
        message: "The request was sent to the phone's clock app.",
      });
    case "uncertain":
      return call.finish({
        status: result.status,
        error: "Ask the owner to check the phone's clock before trying again.",
      });
    case "expired":
      return call.finish({
        status: result.status,
        error:
          "The phone did not respond in time. Ask the owner to keep this chat open on their Android phone.",
      });
    default:
      return call.finish(result);
  }
};
