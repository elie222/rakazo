import type { MessageBlock, PublicTask, TaskStatus } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { storedMessageBlocks } from "@rakazo/db";

const RUN_TASK_STATUS: Record<string, TaskStatus> = {
  queued: "working",
  leased: "working",
  running: "working",
  waiting_input: "needs_input",
  waiting_takeover: "needs_input",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/** A task follows its newest run; a task whose run is not written yet is still starting. */
export function publicTaskStatus(runStatus: string | undefined): TaskStatus {
  return (runStatus && RUN_TASK_STATUS[runStatus]) || "working";
}

function questionOf(block: MessageBlock): string | null {
  if (block.kind === "ask" && block.status !== "answered" && !block.dismissed && !block.expired)
    return block.text;
  if (block.kind === "choice" && !block.answerId) {
    const options = block.options.map((option) => `${option.letter}. ${option.label}`);
    return [block.question, ...options].join("\n");
  }
  return null;
}

type TaskRow = { id: string; botId: string; createdAt: Date; updatedAt: Date };
type RunRow = { status: string; updatedAt: Date };
type ReplyRow = { id: string; blocks: unknown };

/** What the public API says about a task: its newest run's state and the bot's replies. */
export function publicTaskView(task: TaskRow, runs: RunRow[], replies: ReplyRow[]): PublicTask {
  const latest = runs.at(-1);
  const status = publicTaskStatus(latest?.status);
  const texts: string[] = [];
  let question: string | null = null;
  for (const reply of replies) {
    for (const block of storedMessageBlocks(reply)) {
      if (block.kind === "text" && block.text.trim()) texts.push(block.text.trim());
      question = questionOf(block) ?? question;
    }
  }
  const updatedAt = [task.updatedAt, ...runs.map((run) => run.updatedAt)].reduce((a, b) =>
    b > a ? b : a,
  );
  return {
    id: task.id,
    object: "task",
    bot_id: task.botId,
    status,
    output: texts.join("\n\n"),
    question: status === "needs_input" ? question : null,
    error: status === "failed" ? "The bot could not finish this task" : null,
    created_at: task.createdAt.toISOString(),
    updated_at: updatedAt.toISOString(),
  };
}

/**
 * The task as its owner sees it, or null when it is not theirs. Reads tenant rows, so the caller
 * runs it in that member's Space.
 */
export async function readPublicTask(
  prisma: PrismaClient | Prisma.TransactionClient,
  owner: { taskId: string; userId: string; spaceId: string },
): Promise<PublicTask | null> {
  const task = await prisma.task.findFirst({
    where: { id: owner.taskId, userId: owner.userId, spaceId: owner.spaceId },
    select: {
      id: true,
      botId: true,
      createdAt: true,
      updatedAt: true,
      runs: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, status: true, updatedAt: true },
      },
    },
  });
  if (!task) return null;
  const replies = await prisma.message.findMany({
    where: { runId: { in: task.runs.map((run) => run.id) }, role: "bot" },
    orderBy: { seq: "asc" },
    select: { id: true, blocks: true },
  });
  return publicTaskView(task, task.runs, replies);
}
