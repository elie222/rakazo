import { executePaidRequest } from "../../payments/paid-request.js";
import { executePurchaseTool } from "../../payments/purchase-service.js";
import type { RunContext } from "../assembly/run-context.js";
import { addRunSecrets } from "../assembly/run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

// The effect key is stable across replays, so a retried request reuses its purchase.
const purchaseContext = (ctx: RunContext, call: ToolCall) => ({
  ...ctx.context,
  operationId: call.effectKey,
  botId: ctx.bot.id,
});

async function purchaseTool(ctx: RunContext, call: ToolCall) {
  return call.finish(
    await executePurchaseTool(ctx.deps, purchaseContext(ctx, call), ctx.run, call.name, call.args),
  );
}

/** Purchases from the user's connected wallet. */
export const purchaseTools: ToolHandlers = {
  request_purchase: purchaseTool,
  purchase_status: purchaseTool,
  async paid_request(ctx, call) {
    const { result, redactions } = await executePaidRequest(
      ctx.deps,
      purchaseContext(ctx, call),
      ctx.run,
      call.args,
    );
    addRunSecrets(ctx, redactions);
    return call.finish(result);
  },
};
