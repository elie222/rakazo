import { randomUUID } from "node:crypto";
import type {
  TailnetService,
  TailnetTunnelClaims,
  TailnetTunnelDeps,
  TailnetTunnelRecord,
} from "@rakazo/adapters";
import { TailnetTunnelGateway, tailnetTunnelKey } from "@rakazo/adapters";
import type { ComputerCommand } from "@rakazo/contracts";
import { tailnetDestinationKey } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { AppendEventInput, PrismaClient, ThreadEvents } from "@rakazo/db";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * The tunnel gateway bots' computers dial for tailnet destinations. A token only names a run:
 * each tunnel checks that the run is still active and still matches it, then dials as that run's
 * member, so their row-level security applies to the connection lookup.
 */
export function createTailnetTunnel(deps: {
  prisma: Pick<PrismaClient, "run">;
  tailnet: Pick<TailnetService, "dial">;
  events: Pick<ThreadEvents, "append">;
  encryptionKey: string;
  authorize: TailnetTunnelDeps["authorize"];
}): TailnetTunnelGateway {
  return new TailnetTunnelGateway({
    key: tailnetTunnelKey(deps.encryptionKey),
    activeRun: (claims) => activeTailnetRun(deps.prisma, claims),
    authorize: deps.authorize,
    dial: (run, destination, context) =>
      runAsTenant({ spaceId: run.spaceId, userId: run.userId }, () =>
        deps.tailnet.dial(run, destination, context),
      ),
    record: (record) => {
      const { run } = record;
      void runAsTenant({ spaceId: run.spaceId, userId: run.userId }, () =>
        deps.events.append(tailnetTunnelEvent(record)),
      ).catch((error: unknown) => {
        // The Activity feed is a view; a lost entry must not affect the connection.
        getLogger().warn("tailnet tunnel activity was not recorded", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });
}

/** The run a token names, only while it is active and every claim still matches it. */
export async function activeTailnetRun(
  prisma: Pick<PrismaClient, "run">,
  claims: TailnetTunnelClaims,
) {
  const run = await runAsSystem("a tailnet tunnel checks that its run is active", () =>
    prisma.run.findFirst({
      where: {
        id: claims.runId,
        userId: claims.userId,
        spaceId: claims.spaceId,
        botId: claims.botId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      select: { threadId: true, bot: { select: { name: true } } },
    }),
  );
  if (!run) return undefined;
  return {
    userId: claims.userId,
    spaceId: claims.spaceId,
    botId: claims.botId,
    botName: run.bot.name,
    threadId: run.threadId,
  };
}

/** Each tunnel is one line in the computer's Activity view. */
export function tailnetTunnelEvent(record: TailnetTunnelRecord): AppendEventInput {
  const payload: ComputerCommand = {
    executionId: randomUUID(),
    kind: "tailnet",
    command: tailnetDestinationKey(record.destination),
    cwd: "",
    status: "done",
    exitCode: record.outcome === "closed" ? 0 : 1,
    output: record.reason ?? "",
    bytes: record.bytesSent + record.bytesReceived,
  };
  const { run } = record;
  return {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId: run.runId,
    type: "computer.command",
    payload,
  };
}
