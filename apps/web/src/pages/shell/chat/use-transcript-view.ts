import type { Bot, Group, ThreadSnapshot } from "@rakazo/contracts";
import {
  activeThreadRuns,
  answerableAskMessageIds,
  dismissableAskMessageIds,
  foldPeerReplies,
  isActive,
  isRunWorking,
  workingRoutineName,
} from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { useCallback, useMemo } from "react";
import type { ArtifactTarget } from "../../../lib/pages/artifact-open";
import { FALLBACK_BOT_COLOR } from "./chat-shared";
import { resolveTranscriptMemberName as groupTranscriptMemberName } from "./transcript-member-name";

/** What the open chat's transcript shows: its snapshot, the runs working in it, and who is who. */
export function useTranscriptView({
  snapshot,
  inGroup,
  groupId,
  active,
  activeGroup,
  bots,
  archivedBots,
  meId,
}: {
  snapshot: ThreadSnapshot | null;
  inGroup: boolean;
  groupId: string | undefined;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  bots: Bot[];
  archivedBots: Bot[];
  meId: string | undefined;
}) {
  const activeSnapshot = inGroup
    ? snapshot?.groupId === groupId
      ? snapshot
      : null
    : snapshot?.botId === active?.id
      ? snapshot
      : null;
  const currentRuns = activeThreadRuns(activeSnapshot);
  const answerableAskIds = useMemo(
    () => answerableAskMessageIds(activeSnapshot, meId),
    [activeSnapshot, meId],
  );
  const dismissableAskIds = useMemo(
    () => dismissableAskMessageIds(activeSnapshot, meId),
    [activeSnapshot, meId],
  );
  const workingRuns = currentRuns.filter((run) => isRunWorking(run.status));
  const transcript = useMemo(
    () => foldPeerReplies(activeSnapshot?.messages ?? [], { includePeerReceipts: true }),
    [activeSnapshot?.messages],
  );
  const artifactTarget = useMemo<ArtifactTarget>(
    () => (inGroup ? { groupId: groupId ?? "" } : { botId: active?.id ?? "" }),
    [active?.id, groupId, inGroup],
  );
  const transcriptMembers = activeSnapshot?.members ?? activeGroup?.members;
  const resolveBot = useCallback(
    (botId: string) => {
      const bot = bots.find((candidate) => candidate.id === botId);
      if (bot) return bot;
      return transcriptMembers?.find((member) => member.botId === botId);
    },
    [bots, transcriptMembers],
  );
  const workingBots: GroupAvatarMember[] = workingRuns.map((run) => {
    const bot = resolveBot(run.botId);
    return {
      botId: run.botId,
      color: bot?.color ?? FALLBACK_BOT_COLOR,
      avatarSet: bot?.avatarSet,
      name: bot?.name,
      status: run.status,
    };
  });
  const resolveMemberName = useCallback(
    (botId: string | undefined) =>
      groupTranscriptMemberName({
        botId,
        members: transcriptMembers,
        bots,
        archivedBots,
      }),
    [archivedBots, bots, transcriptMembers],
  );
  return {
    activeSnapshot,
    transcript,
    artifactTarget,
    composerRunning: currentRuns.some((run) => isActive(run.status)),
    resolveBot,
    resolveMemberName,
    /** What the transcript draws from the open chat's snapshot. */
    transcriptProps: {
      transcript,
      artifactTarget,
      olderCursor: activeSnapshot?.olderCursor ?? null,
      answerableAskIds,
      dismissableAskIds,
      running: workingRuns.length > 0,
      workingBots,
      workingRoutine: workingRoutineName(workingRuns),
      memberName: resolveMemberName,
      peerBot: resolveBot,
    },
  };
}
