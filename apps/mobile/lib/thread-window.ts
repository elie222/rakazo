import type { ThreadScrollState } from "@rakazo/core";
import { foldPeerReplies, jumpTargetId, leaveThreadWindow, openThreadWindow } from "@rakazo/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { MobileSnapshot } from "./api";
import { rpc } from "./api";
import { isIntegrationsScopeCurrent } from "./integrations-cache";
import type { SavedChatsScope } from "./saved-chats";
import { liveSavedChatsScope } from "./saved-chats";
import type { ThreadJumpAnchor } from "./thread-jump";
import type { ThreadScrollBehavior } from "./thread-scroll";

/** The page a search jump pinned the chat to, until it rejoins the live thread. */
export type PinnedThreadWindow = {
  botId?: string;
  groupId?: string;
  messageId: string;
  threadId: string;
  newerCursor: number | null;
  coveredThroughSeq?: number;
  probeSeq?: number;
};

/** The chat screen's state that places it on a pinned page or on the live thread. */
export type ThreadWindow = {
  pinnedAroundRef: RefObject<PinnedThreadWindow | null>;
  jumpScrollTarget: RefObject<string | null>;
  jumpAnchor: RefObject<ThreadJumpAnchor>;
  joinPinnedAfterLayout: RefObject<number | null>;
  expandedHistoryThread: RefObject<string | null>;
  scrollBehavior: RefObject<ThreadScrollBehavior>;
  snapRef: RefObject<MobileSnapshot | null>;
  setThreadScrollState: (state: ThreadScrollState) => void;
  commitSnap: (next: MobileSnapshot | null) => void;
};

export type ThreadJump = ThreadWindow & {
  historyEpoch: RefObject<number>;
  jumpGeneration: RefObject<number>;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  newerLoadFailed: RefObject<boolean>;
  pinnedScrollMetrics: RefObject<{ offset: number; viewport: number; content: number }>;
  snapshotOrigin: RefObject<SavedChatsScope | null>;
  setExpandedPeerMarkers: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setShowingSaved: (showing: boolean) => void;
};

/** Leaves a pinned page for the live thread, which mounts at the latest message. */
export function showLatestThread(thread: ThreadWindow) {
  const pinned = thread.pinnedAroundRef.current;
  thread.pinnedAroundRef.current = null;
  thread.joinPinnedAfterLayout.current = null;
  thread.jumpScrollTarget.current = null;
  thread.jumpAnchor.current.release();
  thread.expandedHistoryThread.current = null;
  thread.scrollBehavior.current.jumpToLatest();
  // Clearing the pinned refs must render even when the snapshot and scroll flags are unchanged.
  thread.setThreadScrollState(thread.scrollBehavior.current.state());
  const snap = thread.snapRef.current;
  thread.commitSnap(snap && pinned ? leaveThreadWindow(snap, pinned.newerCursor) : snap);
}

/** Opens the page around a message and pins the chat to it. */
export async function applyThreadMessageJump(
  jump: ThreadJump,
  target: { botId?: string; groupId?: string; messageId: string },
) {
  const threadTarget = target.groupId ? { groupId: target.groupId } : { botId: target.botId! };
  const epoch = jump.historyEpoch.current;
  jump.jumpGeneration.current += 1;
  const jumpId = jump.jumpGeneration.current;
  const scope = await liveSavedChatsScope();
  if (!scope || !isIntegrationsScopeCurrent(scope)) return;
  const [snap, page] = await Promise.all([
    rpc("threads/get", threadTarget),
    rpc("threads/messages", {
      ...threadTarget,
      around: { messageId: target.messageId },
    }),
  ]);
  // The epoch check drops a jump that raced a conversation clear (or a bot switch); the
  // generation check drops an older same-thread jump that finished after a newer one.
  if (
    epoch !== jump.historyEpoch.current ||
    jumpId !== jump.jumpGeneration.current ||
    !isIntegrationsScopeCurrent(scope)
  )
    return;
  if (target.groupId && jump.activeGroupId.current !== target.groupId) return;
  if (target.botId && jump.activeBotId.current !== target.botId) return;
  // A relay's dropped marker (e.g. a search hit) lands on its "Messaged X" receipt.
  const messageId = jumpTargetId(
    foldPeerReplies(page.messages, { includePeerReceipts: true }),
    target.messageId,
  );
  const targetInPage = page.messages.some((message) => message.id === messageId);
  const opened = targetInPage ? openThreadWindow(snap, page) : null;
  jump.expandedHistoryThread.current = targetInPage ? page.threadId : null;
  jump.pinnedAroundRef.current = opened
    ? {
        ...threadTarget,
        messageId,
        threadId: page.threadId,
        newerCursor: opened.newerCursor,
      }
    : null;
  jump.jumpAnchor.current.begin(targetInPage ? messageId : null);
  jump.jumpScrollTarget.current = targetInPage ? messageId : null;
  jump.newerLoadFailed.current = false;
  jump.joinPinnedAfterLayout.current = null;
  jump.pinnedScrollMetrics.current = { offset: 0, viewport: 0, content: 0 };
  // Publish the jump refs even when the opened snapshot is already visible.
  jump.setThreadScrollState(jump.scrollBehavior.current.state());
  jump.snapshotOrigin.current = scope;
  const next = opened?.snapshot ?? snap;
  // A reply folded under its peer marker is only drawn once the marker is expanded.
  const markerId = targetInPage
    ? foldPeerReplies(next.messages, { includePeerReceipts: true }).markerOf.get(messageId)
    : undefined;
  if (markerId) {
    jump.setExpandedPeerMarkers((expanded) =>
      expanded.has(markerId) ? expanded : new Set(expanded).add(markerId),
    );
  }
  jump.commitSnap(next);
  jump.setShowingSaved(false);
}

/** Provider recovery belongs to the live end; a page with newer messages still to load hides it. */
export function liveEndRunError<T>(runError: T | null, pinnedNewerCursor: number | null): T | null {
  return pinnedNewerCursor === null ? runError : null;
}
