/** Time one try at downloading a chat-app file sent in a direct message may take. */
export const DIRECT_ATTACHMENT_TIMEOUT_MS = 10 * 60_000;

/** Tries at downloading one chat-app file sent in a direct message, with a pause between them. */
export const DIRECT_ATTACHMENT_ATTEMPTS = 3;

/**
 * Time all files of one direct message may take, counted from when the message arrived. The
 * message reaches the bot once they are in, or with the rest marked as not received after it.
 */
export const DIRECT_MESSAGE_SETTLE_BUDGET_MS = 30 * 60_000;

/**
 * Files of the largest allowed size this process holds in memory at once while downloading
 * chat-app files: its download budget is this many times the upload limit. A file reserves its
 * reported size, or the whole limit when none was reported, before it starts.
 */
export const DOWNLOAD_BUDGET_FILES = 4;
