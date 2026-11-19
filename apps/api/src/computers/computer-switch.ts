import { randomUUID } from "node:crypto";
import path from "node:path";
import { WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import type { BotFilesHome } from "@rakazo/adapters";
import {
  bringBotFiles,
  checkpointRunComputerWorkspace,
  hasSavedBotFiles,
  provisionComputer,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  scheduleComputerSleep,
  screenLeaseIdForRun,
  teamBotWorkspaceDirectory,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor, ComputerMode } from "@rakazo/contracts";
import { ClientError, retry } from "@rakazo/core";
import { computerScopeKey, parseComputerMode, teamComputerUserId } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RouterDeps } from "../router.js";
import { computerContext } from "../routes/shared.js";
import { acquireBootLease } from "./computer-control.js";

type SwitchDeps = Pick<RouterDeps, "prisma" | "sandbox" | "home" | "jobs" | "events" | "dataDir">;

const COPY_ATTEMPTS = 3;
const LEASE_RENEW_MS = 60_000;
const COMPUTER_BUSY = "The computer is busy. Try again in a moment.";

type StoredComputer = {
  id: string;
  homeKey: string;
  scope: string;
  spaceId: string;
  kind: string;
  providerRef: string | null;
  state: string;
};

export function botFilesHome(computer: { homeKey: string; scope: string }): BotFilesHome {
  return { homeKey: computer.homeKey, scope: parseComputerMode(computer.scope) };
}

/**
 * A computer on its way up or down is being saved or restored by someone else right now, so
 * its stored home cannot be copied from yet.
 */
export function assertSettledForMove(computer: { state: string }): void {
  if (computer.state === "booting" || computer.state === "suspending") {
    throw new ClientError("CONFLICT", COMPUTER_BUSY);
  }
}

/**
 * Saves a running Team Computer so its stored home holds the bot's latest files before they
 * are copied from it. One that is not running was saved when it stopped.
 */
export async function saveTeamHomeForMove(
  deps: SwitchDeps,
  actor: Actor,
  botId: string,
  computer: StoredComputer,
): Promise<void> {
  if (computer.state !== "running" || !computer.providerRef) return;
  let revision: string | undefined;
  try {
    revision = await checkpointRunComputerWorkspace(
      deps,
      computer,
      toComputerRef(computer),
      computerContext(actor, botId, "computer.switch"),
    );
  } catch (error) {
    if (!(error instanceof WorkspaceTooLargeError)) throw error;
    throw new ClientError(
      "BAD_REQUEST",
      "The Team Computer holds too much to copy from. Remove large files first.",
    );
  }
  // Other bots are working on it, or it is starting; saving now would interrupt them.
  if (revision === undefined) {
    throw new ClientError("CONFLICT", COMPUTER_BUSY);
  }
}

/**
 * Copies the bot's files from the saved home of the computer it left onto the one it is now
 * linked to, starting that computer when it is not running. Returns false when the bot had no
 * files to bring; throws when the copy did not finish, leaving the caller to undo the move.
 */
export async function bringFilesToComputer(
  deps: SwitchDeps,
  actor: Actor,
  botId: string,
  from: BotFilesHome,
  to: { id: string; scope: string },
): Promise<boolean> {
  const context = computerContext(actor, botId, "computer.switch");
  if (!(await hasSavedBotFiles(deps.home, from, botId, context))) return false;
  const runId = `switch:${randomUUID()}`;
  const lease = await acquireBootLease(deps.prisma, { computerId: to.id, runId, botId });
  let started = false;
  // A large home can take longer to copy than the lease lasts, so it is renewed while held.
  const heartbeat = setInterval(() => {
    void bestEffort("computer move lease", renewComputerExecutionLease(deps.prisma, lease));
  }, LEASE_RENEW_MS);
  heartbeat.unref();
  try {
    const computer = await provisionComputer(deps, to.id, {
      ...context,
      screenLeaseId: screenLeaseIdForRun(lease, runId),
    });
    started = true;
    await retry(
      () =>
        bringBotFiles(
          deps,
          { botId, from, to: { computer, scope: parseComputerMode(to.scope) } },
          context,
        ),
      { attempts: COPY_ATTEMPTS, signal: context.signal },
    );
    return true;
  } finally {
    clearInterval(heartbeat);
    // Also after a failed copy: the bot goes back, and the computer it started must not stay up.
    if (started) scheduleComputerSleep(deps.jobs, to.id);
    await releaseComputerExecutionLease(deps.prisma, lease);
  }
}

/**
 * Whether the computer the bot would move to already holds files of its own from an earlier
 * stay, which bringing its files would replace. A running computer is asked itself, since it
 * may hold files not saved yet; otherwise, or when it cannot answer, its saved home is read.
 */
export async function moveReplacesFiles(
  deps: SwitchDeps,
  actor: Actor,
  bot: { id: string; userId: string; computerId: string | null },
  mode: ComputerMode,
): Promise<boolean> {
  const userId =
    mode === "team"
      ? await teamComputerUserId(deps.prisma, { spaceId: actor.spaceId, userId: bot.userId })
      : bot.userId;
  const destination = await deps.prisma.computer.findUnique({
    where: { scopeKey: computerScopeKey({ mode, spaceId: actor.spaceId, userId, botId: bot.id }) },
    select: { id: true, homeKey: true, scope: true, kind: true, providerRef: true, state: true },
  });
  if (!destination || destination.id === bot.computerId) return false;
  const context = computerContext(actor, bot.id, "computer.switch");
  const files = botFilesHome(destination);
  if (destination.state === "running" && destination.providerRef) {
    const folder = files.scope === "team" ? teamBotWorkspaceDirectory(bot.id) : "";
    const live = await bestEffort(
      "computer move files",
      deps.sandbox.listFiles(toComputerRef(destination), folder, context),
    );
    if (live) return live.some((entry) => !path.posix.basename(entry.path).startsWith("."));
  }
  return hasSavedBotFiles(deps.home, files, bot.id, context);
}
