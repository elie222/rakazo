/** Named apart from any argument a tool may already call `status`. */
export const STEP_STATUS_FIELD = "live_status";

/** The schema description of the `live_status` field every narrated tool is offered. */
export const STEP_STATUS_DESCRIPTION =
  "Two to five words, in the person's language, saying what this call does for them, shown live while it runs (for example “Checking availability”). Not passed to the tool.";
