import { createToolCallRecordStore } from "@rakazo/core";

/** What each live tool call did, fed from the open thread's events. */
export const toolCallRecords = createToolCallRecordStore();
