import { validateHeaderValue } from "node:http";
import { deadlineSignal } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { resolveSupervisorToken } from "@rakazo/core/node/secrets-guard";

loadRootEnv();

const port = Number(process.env.SUPERVISOR_PORT ?? 7091);
const authorization = `Bearer ${resolveSupervisorToken(process.env)}`;
try {
  validateHeaderValue("authorization", authorization);
} catch (error) {
  if (!(error instanceof TypeError && "code" in error && error.code === "ERR_INVALID_CHAR")) {
    throw error;
  }
  throw new Error("SANDBOX_SUPERVISOR_TOKEN contains invalid HTTP header characters.");
}

const response = await fetch(`http://127.0.0.1:${port}/diagnostics/egress`, {
  headers: { authorization },
  redirect: "error",
  signal: deadlineSignal(5_000),
});
if (response.status === 401) {
  throw new Error("The supervisor rejected SANDBOX_SUPERVISOR_TOKEN. Check the service token.");
}
if (!response.ok) throw new Error(`Supervisor egress report returned HTTP ${response.status}.`);
process.stdout.write(await response.text());
