/** Named apart from any argument a tool may already call `status`. */
export const STEP_STATUS_FIELD = "live_status";

/**
 * The schema description of the `live_status` field every narrated tool is offered. It is sent
 * with every tool on every step, so it stays short: the reply guidance says how to write one.
 */
export const STEP_STATUS_DESCRIPTION = "Live status: 2-5 words in the person's language.";
