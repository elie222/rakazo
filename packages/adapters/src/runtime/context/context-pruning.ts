import type { Message } from "@earendil-works/pi-ai";
import {
  SCREENSHOT_REMOVED_NOTE,
  STALE_PAGE_STATE_NOTE,
  TOOL_IMAGE_REMOVED_NOTE,
} from "./runtime-context.prompt.js";

type ToolResultMessage = Extract<Message, { role: "toolResult" }>;

const DEFAULT_COMPUTER_SCREENSHOTS_TO_KEEP = 2;

export class ModelImageLimitError extends Error {}

/**
 * Tools whose result is a view of the current page or screen. Each new result supersedes the
 * earlier ones, so older results only cost context: a long browsing run otherwise re-sends every
 * snapshot it ever took on every model call.
 */
const PAGE_STATE_TOOL_NAMES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "computer_observe",
  "computer_act",
]);
const DEFAULT_PAGE_STATE_RESULTS_TO_KEEP = 3;
/**
 * Only results that actually carry a page (a snapshot tree, an observation) are worth trimming
 * or counting. Navigation confirmations, action receipts and errors are a line or two: trimming
 * them saves nothing, and counting them would push real page state out of the kept set.
 */
const STALE_PAGE_STATE_MIN_CHARS = 1_000;

/**
 * Replace all but the most recent large page-state tool results with a short note. The runtime
 * context policy applies this only when it rebuilds a run's transcript, never to a transcript the
 * model has already seen.
 */
export function pruneStalePageStateContext(
  messages: Message[],
  keep = DEFAULT_PAGE_STATE_RESULTS_TO_KEEP,
): Message[] {
  let remaining = Math.max(0, Math.floor(keep));
  let transformed: Message[] | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "toolResult" || !PAGE_STATE_TOOL_NAMES.has(message.toolName)) continue;
    // Failures are diagnostics, not fresh page state, even when their text is large.
    const returnedError = (message.details as { error?: unknown } | undefined)?.error;
    if (message.isError || (returnedError !== undefined && returnedError !== null)) continue;
    if (textLength(message) < STALE_PAGE_STATE_MIN_CHARS) continue;
    if (remaining > 0) {
      remaining -= 1;
      continue;
    }
    transformed ??= [...messages];
    transformed[index] = {
      ...message,
      content: [{ type: "text", text: STALE_PAGE_STATE_NOTE }],
    };
  }
  return transformed ?? messages;
}

function textLength(message: ToolResultMessage): number {
  let total = 0;
  for (const part of message.content) {
    if (part.type === "text") total += part.text.length;
  }
  return total;
}

/**
 * Keep the latest tool images (screenshots, and images a connected tool returned) within an
 * optional model image budget. The runtime context policy applies this only when it rebuilds a
 * run's transcript; between rebuilds they accumulate up to the model's limit, so a rebuild keeps
 * at most the default two to leave room for more. An older one keeps its result text and gains a
 * one-line note. A user's images are never dropped: a tool can produce its image again, a user's
 * cannot.
 */
export function pruneComputerScreenshotContext(
  messages: Message[],
  maxImagesPerPrompt?: number,
): Message[] {
  const imageLimit = normalizedImageLimit(maxImagesPerPrompt);
  let remaining = DEFAULT_COMPUTER_SCREENSHOTS_TO_KEEP;
  if (imageLimit !== undefined) {
    const userImages = messages.reduce(
      (count, message) => (isToolImageMessage(message) ? count : count + imagePartCount(message)),
      0,
    );
    if (userImages > imageLimit) {
      throw new ModelImageLimitError(
        `The configured model image limit is ${imageLimit}, but the prompt contains ${userImages} user images.`,
      );
    }
    remaining = Math.min(remaining, imageLimit - userImages);
  }
  let transformed: Message[] | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isToolImageMessage(message)) continue;
    const images = imagePartCount(message);
    if (remaining >= images) {
      remaining -= images;
      continue;
    }
    // Keep this result's latest images that still fit the budget, then close it: every older
    // result is pruned.
    const keepFromImage = images - remaining;
    let imagesSeen = 0;
    transformed ??= [...messages];
    transformed[index] = {
      ...message,
      content: [
        ...message.content.filter((part) => {
          if (part.type !== "image") return true;
          imagesSeen += 1;
          return imagesSeen > keepFromImage;
        }),
        {
          type: "text",
          text: isComputerScreenshot(message) ? SCREENSHOT_REMOVED_NOTE : TOOL_IMAGE_REMOVED_NOTE,
        },
      ],
    };
    remaining = 0;
  }
  return transformed ?? messages;
}

/** What a rebuild drops: stale page state, and tool images over the default or model limit. */
export function pruneForRebuild(messages: Message[], maxImagesPerPrompt?: number): Message[] {
  return pruneComputerScreenshotContext(pruneStalePageStateContext(messages), maxImagesPerPrompt);
}

/** A model's image limit as a whole number, or undefined when it has none or it isn't finite. */
export function normalizedImageLimit(maxImagesPerPrompt?: number): number | undefined {
  if (maxImagesPerPrompt === undefined || !Number.isFinite(maxImagesPerPrompt)) return undefined;
  return Math.max(0, Math.floor(maxImagesPerPrompt));
}

export function imagePartCount(message: Message): number {
  if (!Array.isArray(message.content)) return 0;
  return (message.content as Array<{ type: string }>).filter((part) => part.type === "image")
    .length;
}

function isToolImageMessage(message: Message | undefined): message is ToolResultMessage {
  return message?.role === "toolResult" && message.content.some((part) => part.type === "image");
}

function isComputerScreenshot(message: ToolResultMessage): boolean {
  const details = message.details;
  return Boolean(
    details &&
      typeof details === "object" &&
      "frameId" in details &&
      typeof (details as { frameId?: unknown }).frameId === "string",
  );
}
