import { deadlineSignal } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { resolveSupervisorToken } from "@rakazo/core/node/secrets-guard";

loadRootEnv();

try {
  const port = Number(process.env.SUPERVISOR_PORT ?? 7091);
  const response = await fetch(`http://127.0.0.1:${port}/diagnostics/egress`, {
    headers: { authorization: `Bearer ${resolveSupervisorToken(process.env)}` },
    redirect: "error",
    signal: deadlineSignal(5_000),
  });
  if (!response.ok) throw new Error(`Supervisor returned HTTP ${response.status}`);
  process.stdout.write(await response.text());
} catch {
  process.stderr.write("Could not read computer egress status. Check the supervisor service.\n");
  process.exitCode = 1;
}
