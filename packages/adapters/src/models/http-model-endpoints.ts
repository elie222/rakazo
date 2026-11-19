import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

/**
 * The deployment-wide switch for plain-HTTP model endpoints (intranet gateways that cannot
 * terminate TLS). Read at connect time and re-read on every run, so an admin turning it off
 * stops saved HTTP connections without a restart. Runs carry no user context, hence system.
 */
export async function httpModelEndpointsAllowed(
  prisma: Pick<PrismaClient, "deploymentSettings">,
): Promise<boolean> {
  const row = await runAsSystem("read the HTTP model endpoints policy", () =>
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { httpModelEndpointsAllowed: true },
    }),
  );
  return row?.httpModelEndpointsAllowed === true;
}
