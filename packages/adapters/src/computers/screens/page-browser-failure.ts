import type { AdapterContext, ComputerRef, PageBrowserCommand } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { COMPUTER_SCREEN_UNAVAILABLE } from "./computer-screens.js";

type Failed = { error?: unknown; dialog?: unknown; fallback?: unknown };

/**
 * Why a page browser call failed, as one of a few kinds. The error's own words can quote the
 * page, so only the kind is logged. The two messages matched here are written by the desktop
 * and the supervisor themselves.
 */
export function pageBrowserFailureKind(result: Failed) {
  const error = typeof result.error === "string" ? result.error : "";
  if (typeof result.dialog === "string") return "dialog";
  if (error.startsWith("Page browser timed out")) return "timeout";
  if (error.startsWith("Page browser unavailable or interrupted")) return "interrupted";
  if (error === COMPUTER_SCREEN_UNAVAILABLE) return "screen_busy";
  // The page browser hit an error it could not settle, such as losing the browser's debug connection.
  if (result.fallback === "computer_act") return "page_error";
  // Settled: nothing on the page changed, such as a missing element.
  return "refused";
}

export function logPageBrowserFailure(
  computer: ComputerRef,
  request: PageBrowserCommand,
  context: AdapterContext,
  result: Failed,
) {
  getLogger().info("computer.page_browser_failed", {
    "sandbox.id": computer.id,
    provider: computer.kind,
    ...(context.runId ? { "run.id": context.runId } : {}),
    ...(context.botId ? { "bot.id": context.botId } : {}),
    "browser.command": request.command,
    "browser.failure": pageBrowserFailureKind(result),
  });
}
