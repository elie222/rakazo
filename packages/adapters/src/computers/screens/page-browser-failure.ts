import type { AdapterContext, ComputerRef, PageBrowserCommand } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import {
  COMPUTER_SCREEN_UNAVAILABLE,
  PAGE_BROWSER_INTERRUPTED,
  PAGE_BROWSER_TIMED_OUT,
} from "./computer-screens.js";

type Failed = { error?: unknown; dialog?: unknown; fallback?: unknown; uncertain?: unknown };

/**
 * Prefixes of failures the desktop, supervisor and page browser write themselves, never the page.
 * The supervisor and page browser run in the computer, so theirs are copies of their text.
 */
const KNOWN_FAILURES: [prefix: string, kind: string][] = [
  [PAGE_BROWSER_TIMED_OUT, "timeout"],
  [PAGE_BROWSER_INTERRUPTED, "interrupted"],
  [COMPUTER_SCREEN_UNAVAILABLE, "screen_busy"],
  ["This Team Computer cannot allocate another screen", "screen_busy"],
  // The page browser closes an alert itself, so its result names no open dialog.
  ["The page showed an alert", "dialog"],
  ["The page opened tabs that were closed, and this tab could not be read again", "reread_failed"],
];

/**
 * Why a page browser call failed, as one of a few kinds. The error's own words can quote the
 * page, so only the kind is logged.
 */
export function pageBrowserFailureKind(result: Failed) {
  const error = typeof result.error === "string" ? result.error : "";
  if (typeof result.dialog === "string") return "dialog";
  if (/^All (\d+ )?Team Computer screens are in use/.test(error)) return "screen_busy";
  const known = KNOWN_FAILURES.find(([prefix]) => error.startsWith(prefix));
  if (known) return known[1];
  // The page browser hit an error it could not settle, such as losing the browser's debug connection.
  if (result.fallback === "computer_act") return "page_error";
  // A step stopped where its effect is unknown, such as a card field that may not have cleared.
  if (result.uncertain === true) return "uncertain";
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
