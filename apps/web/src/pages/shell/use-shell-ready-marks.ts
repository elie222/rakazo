import { useLayoutEffect } from "react";
import { markAfterPaint, markOnce } from "../../lib/platform/performance";
import { markShellReady } from "./space-switch";

/** Marks the shell's first bots, thread and ready paint, and ends a space switch once it is ready. */
export function useShellReadyMarks({
  botsLoaded,
  active,
  snapshotBotId,
  ready,
}: {
  botsLoaded: boolean;
  active: { id: string } | undefined;
  /** The bot whose thread was read last. */
  snapshotBotId: string | undefined;
  ready: boolean;
}) {
  useLayoutEffect(() => {
    if (botsLoaded) {
      markOnce("rk:renderer:bots-committed");
      markAfterPaint("rk:renderer:bots-painted");
    }
    if (active && snapshotBotId === active.id) {
      markOnce("rk:renderer:thread-committed");
      markAfterPaint("rk:renderer:thread-painted");
    }
    if (ready) {
      markShellReady();
      markOnce("rk:renderer:shell-ready");
      markAfterPaint("rk:renderer:shell-painted");
    }
  }, [active, botsLoaded, ready, snapshotBotId]);
}
