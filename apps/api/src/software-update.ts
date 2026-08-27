import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Fixed track for self-hosted git checkouts. Never interpolate untrusted input into argv. */
export const UPDATE_REMOTE = "origin";
export const UPDATE_BRANCH = "main";
export const UPDATE_REF = `${UPDATE_REMOTE}/${UPDATE_BRANCH}`;

const GIT_TIMEOUT_MS = 60_000;

export type SoftwareUpdateCheck = {
  available: boolean;
  currentCommit: string;
  targetCommit: string;
  isUpToDate: boolean;
  behindBy: number;
  dirty: boolean;
  changedFiles: string[];
  branch: string;
  remote: string;
  canAutoUpdate: boolean;
};

export type SoftwareUpdateApply = {
  success: boolean;
  message: string;
  updatedToCommit?: string;
};

export function parsePorcelain(stdout: string): { dirty: boolean; changedFiles: string[] } {
  const changedFiles = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 3)
    .map((line) => {
      // Porcelain: two status chars, then a space, then the path (renames use " -> ").
      const rest = line.slice(2).replace(/^\s/, "");
      const arrow = rest.lastIndexOf(" -> ");
      return (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim();
    })
    .filter(Boolean);
  return { dirty: changedFiles.length > 0, changedFiles };
}

export function parseBehindCount(stdout: string): number {
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function unavailableCheck(): SoftwareUpdateCheck {
  return {
    available: false,
    currentCommit: "unknown",
    targetCommit: "unknown",
    isUpToDate: false,
    behindBy: 0,
    dirty: false,
    changedFiles: [],
    branch: UPDATE_BRANCH,
    remote: UPDATE_REMOTE,
    canAutoUpdate: false,
  };
}

export function buildCheckResult(input: {
  currentCommit: string;
  targetCommit: string;
  behindBy: number;
  dirty: boolean;
  changedFiles: string[];
  branch: string;
  remote: string;
}): SoftwareUpdateCheck {
  const isUpToDate = input.behindBy === 0;
  return {
    available: true,
    currentCommit: input.currentCommit,
    targetCommit: input.targetCommit,
    isUpToDate,
    behindBy: input.behindBy,
    dirty: input.dirty,
    changedFiles: input.changedFiles,
    branch: input.branch,
    remote: input.remote,
    canAutoUpdate: !input.dirty && !isUpToDate && input.behindBy > 0,
  };
}

export function applyFailureMessage(
  reason: "dirty" | "not-git" | "not-ff" | "failed",
): SoftwareUpdateApply {
  switch (reason) {
    case "dirty":
      return { success: false, message: "Local changes. Stash or commit first." };
    case "not-git":
      return { success: false, message: "Updates unavailable." };
    case "not-ff":
      return { success: false, message: "Cannot fast-forward. Update manually." };
    default:
      return { success: false, message: "Update failed." };
  }
}

function classifyGitError(error: unknown): "not-git" | "not-ff" | "failed" {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  if (error && typeof error === "object") {
    const err = error as { stderr?: unknown; stdout?: unknown };
    if (typeof err.stderr === "string") parts.push(err.stderr);
    if (typeof err.stdout === "string") parts.push(err.stdout);
  }
  const lower = parts.join("\n").toLowerCase();
  if (lower.includes("not a git repository") || lower.includes("outside repository")) {
    return "not-git";
  }
  if (
    lower.includes("not possible to fast-forward") ||
    lower.includes("diverging branches") ||
    lower.includes("refusing to merge unrelated histories")
  ) {
    return "not-ff";
  }
  return "failed";
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function isGitCheckout(): Promise<boolean> {
  try {
    const out = await git(["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export async function checkSoftwareUpdate(): Promise<SoftwareUpdateCheck> {
  if (!(await isGitCheckout())) return unavailableCheck();

  try {
    const statusRaw = await git(["status", "--porcelain"]);
    const { dirty, changedFiles } = parsePorcelain(statusRaw);

    // Fetch first so origin/main exists locally, then compare HEAD to that ref.
    await git(["fetch", UPDATE_REMOTE, UPDATE_BRANCH]);

    const [currentCommit, targetCommit, behindRaw, branchRaw] = await Promise.all([
      git(["rev-parse", "HEAD"]),
      git(["rev-parse", UPDATE_REF]),
      git(["rev-list", "--count", `HEAD..${UPDATE_REF}`]),
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);

    return buildCheckResult({
      currentCommit: currentCommit.trim(),
      targetCommit: targetCommit.trim(),
      behindBy: parseBehindCount(behindRaw),
      dirty,
      changedFiles,
      branch: branchRaw.trim() || UPDATE_BRANCH,
      remote: UPDATE_REMOTE,
    });
  } catch {
    // Docker images / hosted deploys may lack a usable remote — degrade, do not pretend up to date.
    return unavailableCheck();
  }
}

export async function applySoftwareUpdate(): Promise<SoftwareUpdateApply> {
  if (!(await isGitCheckout())) return applyFailureMessage("not-git");

  try {
    const statusRaw = await git(["status", "--porcelain"]);
    const { dirty } = parsePorcelain(statusRaw);
    if (dirty) return applyFailureMessage("dirty");

    await git(["fetch", UPDATE_REMOTE, UPDATE_BRANCH]);
    await git(["merge", "--ff-only", UPDATE_REF]);
    const head = (await git(["rev-parse", "HEAD"])).trim();
    return { success: true, message: "Updated.", updatedToCommit: head };
  } catch (error) {
    return applyFailureMessage(classifyGitError(error));
  }
}
