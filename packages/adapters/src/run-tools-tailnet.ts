import { TAILNET_CONNECT_TOOL } from "@rakazo/core";
import { requestSite } from "@rakazo/core/egress";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

/**
 * Past the gate, the destination is allowed for this run (or always, by a rule): the tunnel
 * gateway checks the same approval when a command connects. Nothing connects here.
 */
async function tailnetConnect(_ctx: RunContext, call: ToolCall) {
  const destination = requestSite(TAILNET_CONNECT_TOOL, call.args);
  if (!destination) return call.finish({ error: "host and port must name a tailnet destination" });
  return call.finish({
    allowed: destination,
    reach:
      "rakazo-net run <command> for HTTP(S); ssh -o ProxyCommand='rakazo-net nc %h %p'; rakazo-net forward <local port> <host>:<port> for other clients",
  });
}

export const tailnetTools: ToolHandlers = { [TAILNET_CONNECT_TOOL]: tailnetConnect };
