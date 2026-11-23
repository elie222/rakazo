import type { Routine, TaughtSkill, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { withLiveStreamingProgress } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";

export type PinnedAround = {
  botId?: string;
  groupId?: string;
  messageId: string;
  threadId: string;
  messages: ThreadMessage[];
  olderCursor: number | null;
};

/** The open chat's snapshot, the bot data loaded with it, and where its loaded history stands. */
export function useThreadState(streamResponses: boolean) {
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const [taughtSkills, setTaughtSkills] = useState<TaughtSkill[]>([]);
  const [taughtSkillsBotId, setTaughtSkillsBotId] = useState<string | null>(null);
  const bootstrappedThread = useRef<ThreadSnapshot | null>(null);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const messageScroll = useRef<HTMLDivElement>(null);
  const pinnedAroundRef = useRef<PinnedAround | null>(null);

  function commitSnapshot(next: ThreadSnapshot | null) {
    snapshotRef.current = next;
    setSnapshot(withLiveStreamingProgress(next, streamResponsesRef.current));
  }

  useEffect(() => {
    setSnapshot(withLiveStreamingProgress(snapshotRef.current, streamResponses));
  }, [streamResponses]);

  function updateSnapshot(update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) {
    commitSnapshot(update(snapshotRef.current));
  }

  /** Drops expanded or pinned history, and any page still loading for it. */
  function resetHistory() {
    expandedHistoryThread.current = null;
    pinnedAroundRef.current = null;
    historyEpoch.current += 1;
  }

  /** Empties the open chat after its history was cleared. */
  function clearOpenThread() {
    resetHistory();
    updateSnapshot((current) =>
      current ? { ...current, messages: [], olderCursor: null, run: null } : current,
    );
  }

  return {
    snapshot,
    snapshotRef,
    commitSnapshot,
    updateSnapshot,
    routines,
    setRoutines,
    routinesBotId,
    setRoutinesBotId,
    taughtSkills,
    setTaughtSkills,
    taughtSkillsBotId,
    setTaughtSkillsBotId,
    bootstrappedThread,
    expandedHistoryThread,
    historyEpoch,
    messageScroll,
    pinnedAroundRef,
    resetHistory,
    clearOpenThread,
  };
}

export type ThreadState = ReturnType<typeof useThreadState>;
