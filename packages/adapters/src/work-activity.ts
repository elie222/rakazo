import {
  ACTIVE_RUN_STATUSES,
  displayName,
  isBackgroundRunTrigger,
  isRunWaitingOnUser,
  truncatePlainText,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { credentialDigest } from "./credential-digest.js";
import { EncryptedSecretStore } from "./secrets.js";

/** One bot at work, as a row on the card. Opens its chat when tapped. */
export type WorkActivityRow = {
  status: "working" | "waiting";
  /** The bot's name. */
  title: string;
  /** The bot's latest step, or empty. */
  line: string;
  spaceId: string;
  botId?: string;
  groupId?: string;
};

/** What a phone's live status card shows: every bot of the user's still at work. */
export type WorkActivityState = {
  /** Bots at work, including those past the rows shown. */
  count: number;
  /** Bots waiting on the user. */
  waiting: number;
  /** Bots waiting on the user first, then the newest work. */
  rows: WorkActivityRow[];
};

export type WorkActivityPush = {
  state: WorkActivityState;
  /** Nothing is at work any more: the card goes away. */
  ended: boolean;
  /** Something new needs the user, or the card ends: show it at once. */
  urgent: boolean;
  /** Unix seconds, read before the state, so a later push never carries an older state. */
  at: number;
};

/** Delivers updates to one phone's live status card. */
export interface WorkActivityPushProvider {
  send(token: string, push: WorkActivityPush): Promise<"sent" | "invalid" | "unavailable">;
}

/** The card's height fits this many rows; the count covers the rest. */
export const WORK_ACTIVITY_ROWS = 4;
const LINE_MAX_CHARS = 120;
/** Progress events read back to find the latest step; streamed text sits between them. */
const STEP_LOOKBACK = 20;
/** Recent runs of a changed thread whose owners' cards may need an update. */
const THREAD_RUN_LOOKBACK = 20;
/** A busy thread or user is looked at most this often. The last change always goes out. */
const UPDATE_WINDOW_MS = 3_000;
const EMPTY_STATE: WorkActivityState = { count: 0, waiting: 0, rows: [] };

/**
 * Keeps each phone's live status card in step with the user's bots: registered when the user
 * sends, updated as any of their runs change, and ended once none is at work.
 */
export class WorkActivities {
  private readonly encryption: EncryptedSecretStore;
  private readonly pending = new Map<string, { again: boolean }>();

  constructor(
    private readonly prisma: PrismaClient,
    encryptionKey: string,
    private readonly provider: WorkActivityPushProvider,
    private readonly windowMs = UPDATE_WINDOW_MS,
  ) {
    this.encryption = new EncryptedSecretStore(encryptionKey);
  }

  /** Follows the user's work with this card. False when none of their bots is at work. */
  async register(userId: string, token: string): Promise<boolean> {
    if ((await this.state(userId)).count === 0) return false;
    const tokenDigest = credentialDigest(token);
    const sealed = await this.encryption.put(
      token,
      {
        operationId: "work-activity.register",
        traceId: "work-activity.register",
        spaceId: "",
        userId,
        signal: new AbortController().signal,
      },
      { recordId: recordId(tokenDigest) },
    );
    // A token the card already had keeps its last state, so nothing is sent twice.
    await runAsSystem("register a live status card", () =>
      this.prisma.workActivityToken.upsert({
        where: { tokenDigest },
        create: { tokenDigest, userId, ciphertext: sealed.ciphertext },
        update: { userId },
      }),
    );
    // The work may have moved on before the card registered.
    this.userChanged(userId);
    return true;
  }

  /** A thread changed: update the cards of everyone with recent work in it. */
  threadChanged(threadId: string): void {
    this.throttle(`thread:${threadId}`, async () => {
      const runs = await runAsSystem("find whose work a thread change touches", () =>
        this.prisma.run.findMany({
          where: { threadId },
          orderBy: { createdAt: "desc" },
          take: THREAD_RUN_LOOKBACK,
          select: { userId: true },
        }),
      );
      for (const userId of new Set(runs.map((run) => run.userId))) this.userChanged(userId);
    });
  }

  userChanged(userId: string): void {
    this.throttle(`user:${userId}`, () => this.sync(userId));
  }

  /** Runs now, then at most once per window while changes keep coming; the last one always runs. */
  private throttle(key: string, run: () => Promise<void>): void {
    const pending = this.pending.get(key);
    if (pending) {
      pending.again = true;
      return;
    }
    const entry = { again: false };
    this.pending.set(key, entry);
    void run()
      .catch((error) => getLogger().warn("work_activity.sync_failed", { error }))
      .finally(() => {
        const timer = setTimeout(() => {
          this.pending.delete(key);
          if (entry.again) this.throttle(key, run);
        }, this.windowMs);
        timer.unref?.();
      });
  }

  async sync(userId: string): Promise<void> {
    const at = Math.floor(Date.now() / 1000);
    const cards = await runAsSystem("load a user's live status cards", () =>
      this.prisma.workActivityToken.findMany({ where: { userId } }),
    );
    if (!cards.length) return;
    const state = await this.state(userId);
    const json = JSON.stringify(state);
    await Promise.all(
      cards.map(async (card) => {
        if (json === card.lastState) return;
        const last: WorkActivityState = card.lastState ? JSON.parse(card.lastState) : EMPTY_STATE;
        const ended = state.count === 0;
        const token = await this.encryption.load(card.ciphertext, recordId(card.tokenDigest));
        const result = await this.provider.send(token, {
          // The card keeps its last rows while it leaves.
          state: ended ? last : state,
          ended,
          urgent: ended || state.waiting > last.waiting,
          at,
        });
        // An ended card is not retried: no work is left to change and retry it.
        if (ended || result === "invalid") {
          await runAsSystem("drop a live status card", () =>
            this.prisma.workActivityToken.deleteMany({ where: { tokenDigest: card.tokenDigest } }),
          );
        } else if (result === "sent") {
          await runAsSystem("record a live status card update", () =>
            this.prisma.workActivityToken.updateMany({
              where: { tokenDigest: card.tokenDigest },
              data: { lastState: json },
            }),
          );
        }
      }),
    );
  }

  private async state(userId: string): Promise<WorkActivityState> {
    const runs = await runAsSystem("read a user's work in progress", () =>
      this.prisma.run.findMany({
        where: { userId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          trigger: true,
          spaceId: true,
          threadId: true,
          botId: true,
          bot: { select: { name: true } },
          thread: { select: { groupId: true } },
        },
      }),
    );
    // One row per bot in a chat: a continuation is the same work.
    const seen = new Set<string>();
    const shown = runs.filter((run) => {
      const key = `${run.threadId}:${run.botId}`;
      if (isBackgroundRunTrigger(run.trigger) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const waiting = shown.filter((run) => isRunWaitingOnUser(run.status));
    const ordered = [...waiting, ...shown.filter((run) => !isRunWaitingOnUser(run.status))];
    const rows = await Promise.all(
      ordered.slice(0, WORK_ACTIVITY_ROWS).map(
        async (run): Promise<WorkActivityRow> => ({
          status: isRunWaitingOnUser(run.status) ? "waiting" : "working",
          title: displayName(run.bot.name, "Bot"),
          line: isRunWaitingOnUser(run.status) ? "" : await this.latestStep(run.id),
          spaceId: run.spaceId,
          ...(run.thread.groupId ? { groupId: run.thread.groupId } : { botId: run.botId }),
        }),
      ),
    );
    return { count: shown.length, waiting: waiting.length, rows };
  }

  private async latestStep(runId: string): Promise<string> {
    const progress = await runAsSystem("read a run's latest step", () =>
      this.prisma.event.findMany({
        where: { runId, type: "thread.progress" },
        orderBy: { seq: "desc" },
        take: STEP_LOOKBACK,
        select: { payload: true },
      }),
    );
    for (const { payload } of progress) {
      const step = payload as { activity?: unknown; text?: unknown };
      if (step.activity === true && typeof step.text === "string" && step.text.trim())
        return truncatePlainText(step.text.trim().replace(/\s+/g, " "), LINE_MAX_CHARS);
    }
    return "";
  }
}

function recordId(tokenDigest: string): string {
  return `work-activity:${tokenDigest}`;
}
