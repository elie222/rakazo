import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import { toTeamChatInbound } from "@rakazo/adapters";
import { SpaceDeletionInProgressError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { MessagingInboundDeps } from "./messaging-inbound.js";
import { teamChatSenderCanWakeMessageRoutines, wakeMessageRoutines } from "./messaging-inbound.js";
import type { TeamChatBridge } from "./team-chat-bridge.js";
import { isDeferredReservationLost } from "./team-chat-bridge.js";

/**
 * Routes one TeamChat delivery: a sender who may wake message routines gets them first, under a
 * deferred reservation, and the bridge's own agent only when no routine took the message.
 */
export function createTeamChatInboundHandler(
  inboundDeps: MessagingInboundDeps,
  inbound: (event: MessagingInboundMessage) => Promise<void>,
) {
  return async (bridge: TeamChatBridge, event: Parameters<typeof wakeMessageRoutines>[2]) => {
    const mapped = toTeamChatInbound(event);
    if (!mapped) {
      await inbound(event);
      return;
    }
    const canWake = await teamChatSenderCanWakeMessageRoutines(inboundDeps, event);
    if (!canWake) {
      await bridge.receive(mapped);
      return;
    }

    // Persist a non-reconcilable row until routine routing owns or releases
    // the message, so the timer cannot start a second TeamChat run.
    const target = await bridge.receive(mapped, { queueAgent: false });
    if (!target.deferred) return;
    const leaseHeartbeat = await bridge.startDeferredReservationHeartbeat(target.externalMessageId);
    let woken = false;
    // A Space being deleted takes no message: accepted and dropped, with no agent fallback, so the
    // provider does not redeliver it. Its transcript copy stays.
    const dropWhileDeleting = async () => {
      await bridge.resolveDeferredMessage(target.externalMessageId, "ignored", mapped.kind);
      getLogger().info("messaging inbound dropped", { reason: "space being deleted" });
    };
    bridge.markRoutineWakeInFlight(target.externalMessageId);
    try {
      const wakePromise = wakeMessageRoutines(inboundDeps, target, event, {
        // Must match TeamChatBridge ExternalConversation / recovery provider.
        deliveryProvider: bridge.providerId,
        externalMessageId: target.externalMessageId,
      });
      try {
        woken = await Promise.race([wakePromise, leaseHeartbeat.lost]);
      } catch (error) {
        if (isDeferredReservationLost(error)) {
          // Lease loss must not start a fallback agent beside an in-flight
          // wake: re-hold exclusive ownership while awaiting that wake, then
          // resolve from its settled result.
          let hold: { stop: () => void } | undefined;
          try {
            hold = await bridge.startDeferredReservationHeartbeat(target.externalMessageId);
          } catch {
            // Row already left deferred; wake CAS / resolve decide the winner.
          }
          try {
            try {
              woken = await wakePromise;
            } catch (wakeError) {
              if (wakeError instanceof SpaceDeletionInProgressError) {
                await dropWhileDeleting();
                return;
              }
              const released = await bridge.resolveDeferredMessage(
                target.externalMessageId,
                "agent",
                mapped.kind,
              );
              if (!released) {
                throw new Error("Team chat deferred message ownership conflict", {
                  cause: wakeError,
                });
              }
              await bridge.reconcileOnce();
              getLogger().error(
                "team chat routine wake failed after deferred lease loss",
                wakeError,
              );
              return;
            }
          } finally {
            hold?.stop();
          }
        } else if (error instanceof SpaceDeletionInProgressError) {
          await dropWhileDeleting();
          return;
        } else {
          await bridge.resolveDeferredMessage(target.externalMessageId, "agent", mapped.kind);
          await bridge.reconcileOnce();
          throw error;
        }
      }
      const resolved = await bridge.resolveDeferredMessage(
        target.externalMessageId,
        woken ? "routine" : "agent",
        mapped.kind,
      );
      if (!resolved) {
        throw new Error("Team chat deferred message ownership conflict");
      }
      if (!woken) await bridge.reconcileOnce();
    } finally {
      bridge.clearRoutineWakeInFlight(target.externalMessageId);
      leaseHeartbeat.stop();
    }
  };
}
