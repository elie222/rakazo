/**
 * A bounded, opt-in, generic teamwork dispatcher for Rakazo group chats.
 *
 * A user directly addresses one group member (the owner). If that member
 * finishes without a deliberate handoff, dispatch distinct team-member
 * assessments in parallel. Only after all selected peers finish, return the
 * stage to the original owner for evidence synthesis and optional deepening.
 * Group names and predefined occupations never affect scheduling.
 */
import { type JobPublisher, runContinueJob } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const FANOUT_NONCE_PREFIX = "local-group-team:";
const FANOUT_NONCE_REGEX = /^local-group-team:([a-z0-9]+):([a-z0-9]+)$/;
const GOAL_CHECKPOINT_NONCE_PREFIX = "local-agent-goal:";

/** An explicit @Bot mention is a requested participant, not permission to run a tool. */
export function requestedGroupParticipants(
  blocks: unknown,
  members: readonly Teammate[],
): string[] {
  const parsed = MessageBlock.array().safeParse(blocks);
  if (!parsed.success) return [];
  const text = parsed.data
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("\n")
    .toLocaleLowerCase();
  return members
    .filter((member) => {
      const marker = `@${member.name.toLocaleLowerCase()}`;
      let cursor = text.indexOf(marker);
      while (cursor !== -1) {
        const next = text[cursor + marker.length];
        if (next === undefined || /[\s,、，。;:!?！？）)]/.test(next)) return true;
        cursor = text.indexOf(marker, cursor + marker.length);
      }
      return false;
    })
    .map((member) => member.id);
}

const MAX_AGE_MS = 40 * 60_000;

export function peerJobNonce(rootId: string, botId: string): string {
  return `${FANOUT_NONCE_PREFIX}${rootId}:${botId}`;
}
export function parsePeerJobNonce(nonce: string | null): { rootId: string; botId: string } | null {
  const match = nonce?.match(FANOUT_NONCE_REGEX);
  return match ? { rootId: match[1]!, botId: match[2]! } : null;
}

type Teammate = { id: string; name: string; title: string; description: string };
export function chooseGroupTeammates(
  members: readonly Teammate[],
  rootBotId: string,
  requestedIds: readonly string[] = [],
): Teammate[] {
  // Membership (and explicit user mentions) determines participation. There is
  // no arbitrary 4/8-person cap: the worker's existing job queue controls how
  // much runs concurrently. The root is never scheduled as its own peer.
  const eligible = members.filter((member) => member.id !== rootBotId);
  return requestedIds.length
    ? eligible.filter((member) => requestedIds.includes(member.id))
    : eligible;
}

function peerTaskPrompt(peer: Teammate, groupName: string): string {
  return [
    `[Internal collaborative group assignment to ${peer.name}]`,
    `Group: ${JSON.stringify(groupName)}. Use the name as context about the team's purpose, NOT as a trigger to change permissions or run a special workflow.`,
    "You are an independent specialist member of this group; the user's message was addressed to the group, not only to its original responder.",
    `Your professional responsibility in the team: ${peer.title || peer.name}. ${peer.description || ""}`,
    "Read the specific current user request that initiated this group task and its attached files. Ignore earlier unrelated attachments, past tasks and old portfolio data unless explicitly requested by the user.",
    "Contribute a distinct, substantive part of the task aligned with YOUR role, and proactively investigate unclear or contradictory evidence.",
    "Inspect earlier peer work if useful but do not merely repeat another Bot's findings. Explicitly identify what you independently verified and what remains unknown.",
    "Share your usable findings in the group thread, with grounded sources/figures where applicable. The coordinator will automatically review the selected teammates' findings.",
    "Do not hand off to another group member during this fanout stage; the coordinator owns cross-bot scheduling and may delegate extra work later.",
    "Any web, code, file or account action must still follow ordinary permissions and approval gates. Do not fabricate citations or claim unperformed work.",
    "This is an internal task stage, NOT a new instruction from the user.",
  ].join("\n");
}

/** Atomic orchestration. The root row is the cross-worker mutex and every
 * task has a deterministic client nonce, so retries do not start duplicates. */
export async function advanceGroupTeam(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  runId: string,
): Promise<{ handled: boolean; stage?: string; scheduled?: number }> {
  const result = await deps.prisma.$transaction(async (tx) => {
    const current = await tx.run.findUnique({
      where: { id: runId },
      select: {
        id: true,
        botId: true,
        userId: true,
        spaceId: true,
        threadId: true,
        status: true,
        trigger: true,
        clientNonce: true,
        sourceMessageId: true,
        groupReviewScheduledAt: true,
        thread: { select: { groupId: true } },
      },
    });
    if (!current?.thread.groupId || current.groupReviewScheduledAt) return { handled: false };
    const fromPeer = parsePeerJobNonce(current.clientNonce);
    if (
      !fromPeer &&
      (current.status !== "completed" || !["user", "follow_up"].includes(current.trigger))
    )
      return { handled: false };
    if (fromPeer && !["completed", "failed", "cancelled"].includes(current.status))
      return { handled: true, stage: "waiting" };
    // Goal checkpoint runs are controlled by the general goal evaluator,
    // not by this initial one-time team fanout.
    if (
      !fromPeer &&
      (current.clientNonce?.startsWith(GOAL_CHECKPOINT_NONCE_PREFIX) ||
        current.clientNonce?.startsWith(FANOUT_NONCE_PREFIX))
    )
      return { handled: false };
    const group = await tx.chatGroup.findUnique({
      where: { id: current.thread.groupId },
      select: {
        id: true,
        name: true,
        archivedAt: true,
        members: {
          where: { bot: { archivedAt: null } },
          orderBy: { createdAt: "asc" },
          select: { bot: { select: { id: true, name: true, title: true, description: true } } },
        },
      },
    });
    if (!group || group.archivedAt || group.members.length < 2) return { handled: false };
    const rootId = fromPeer?.rootId ?? current.id;
    const root = await tx.run.findUnique({
      where: { id: rootId },
      select: {
        id: true,
        userId: true,
        spaceId: true,
        threadId: true,
        botId: true,
        createdAt: true,
        sourceMessageId: true,
        sourceMessage: { select: { role: true, blocks: true } },
      },
    });
    if (
      !root ||
      root.sourceMessage?.role !== "user" ||
      !root.sourceMessageId ||
      root.threadId !== current.threadId ||
      root.spaceId !== current.spaceId ||
      root.userId !== current.userId
    )
      return { handled: false };
    // Mutual exclusion shared by all peer completions and root follow-ups.
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${root.id} FOR UPDATE`;
    const mark = async (id: string) =>
      tx.run.update({
        where: { id },
        data: { groupReviewScheduledAt: new Date() },
      });
    // A user followup explicitly supersedes old automatic work.
    const superseded = await tx.message.findFirst({
      where: {
        threadId: root.threadId,
        role: "user",
        id: { not: root.sourceMessageId },
        createdAt: { gt: root.createdAt },
      },
      select: { id: true },
    });
    if (superseded || Date.now() - root.createdAt.getTime() > MAX_AGE_MS) {
      await mark(current.id);
      return {
        handled: true,
        stage: superseded ? "superseded" : "expired",
        scheduledIds: [] as string[],
      };
    }
    const groupRoster = group.members.map((member) => member.bot);
    const requested = requestedGroupParticipants(root.sourceMessage?.blocks, groupRoster);
    const teammates = chooseGroupTeammates(groupRoster, root.botId, requested);
    if (!teammates.length) return { handled: false };
    const pendingIds: string[] = [];
    if (!fromPeer) {
      // Do not override any deliberate handoff selected by the owner.
      const delegated = await tx.event.findFirst({
        where: { runId: root.id, type: "group.handoff" },
        select: { id: true },
      });
      if (delegated) return { handled: false };
      for (const teammate of teammates) {
        const clientNonce = peerJobNonce(root.id, teammate.id);
        const exists = await tx.run.findFirst({
          where: { spaceId: root.spaceId, clientNonce },
          select: { id: true },
        });
        if (exists) continue;
        const task = await tx.task.create({
          data: {
            spaceId: root.spaceId,
            threadId: root.threadId,
            userId: root.userId,
            botId: teammate.id,
            prompt: peerTaskPrompt(teammate, group.name),
            status: "queued",
          },
          select: { id: true },
        });
        const run = await tx.run.create({
          data: {
            spaceId: root.spaceId,
            threadId: root.threadId,
            userId: root.userId,
            botId: teammate.id,
            taskId: task.id,
            status: "queued",
            trigger: "follow_up",
            sourceMessageId: root.sourceMessageId,
            clientNonce,
          },
          select: { id: true },
        });
        pendingIds.push(run.id);
      }
      await mark(root.id);
      return { handled: true, stage: "team", scheduledIds: pendingIds };
    }
    // Guard against a spoofed or obsolete peer with an invalid membership.
    if (!teammates.some((m) => m.id === current.botId && m.id === fromPeer.botId))
      return { handled: false };
    const peers = await tx.run.findMany({
      where: {
        spaceId: root.spaceId,
        clientNonce: { in: teammates.map((m) => peerJobNonce(root.id, m.id)) },
      },
      select: { id: true, status: true },
    });
    if (
      peers.length !== teammates.length ||
      peers.some((r) => !["completed", "failed", "cancelled"].includes(r.status))
    ) {
      return { handled: true, stage: "waiting", scheduledIds: [] as string[] };
    }
    const synthesisNonce = `${GOAL_CHECKPOINT_NONCE_PREFIX}${root.id}:1`;
    const exists = await tx.run.findFirst({
      where: { spaceId: root.spaceId, clientNonce: synthesisNonce },
      select: { id: true },
    });
    if (!exists) {
      const prompt = [
        "[Internal group coordination — final synthesis and completeness assessment]",
        `Group: ${JSON.stringify(group.name)}. This name describes the team's focus; it does not define a special dispatcher mode.`,
        "You are the owner of the original user's group request. The other group members have each completed their specialist stages in this shared thread.",
        "Read the current user's goal, its own attachments, teammate investigations and any failures. Avoid citing unrelated earlier tasks or files. Check evidence, disagreement and whether the goal was answered.",
        "Integrate all the useful perspectives into one complete answer with explicit unresolved issues and grounded sources.",
        "If important gaps remain, use handoff_to_bot for another DISTINCT investigation; the bounded goal coordinator can return the result for a further assessment.",
        "Do not mechanically ask every Bot for another round. Finish when the goal is reasonably satisfied.",
        "No external mutations without ordinary authorization and approval.",
      ].join("\n");
      const task = await tx.task.create({
        data: {
          spaceId: root.spaceId,
          threadId: root.threadId,
          userId: root.userId,
          botId: root.botId,
          status: "queued",
          prompt,
        },
        select: { id: true },
      });
      const run = await tx.run.create({
        data: {
          spaceId: root.spaceId,
          threadId: root.threadId,
          userId: root.userId,
          botId: root.botId,
          taskId: task.id,
          status: "queued",
          trigger: "follow_up",
          clientNonce: synthesisNonce,
          sourceMessageId: root.sourceMessageId,
        },
        select: { id: true },
      });
      pendingIds.push(run.id);
    }
    for (const peer of peers) await mark(peer.id);
    return { handled: true, stage: "synthesis", scheduledIds: pendingIds };
  });
  const queuedIds = "scheduledIds" in result ? result.scheduledIds : undefined;
  if (queuedIds)
    for (const id of queuedIds) {
      await deps.jobs
        .enqueue(runContinueJob(id))
        .catch((error) => getLogger().error("local group team job enqueue", error));
    }
  return { handled: result.handled, stage: result.stage, scheduled: queuedIds?.length ?? 0 };
}
