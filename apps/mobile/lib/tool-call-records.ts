import { createToolCallRecordStore } from "@rakazo/core";
import { registerSessionDiskCache } from "./session";

/** What each live tool call did, fed from the open thread's events. */
export const toolCallRecords = createToolCallRecordStore();

registerSessionDiskCache(toolCallRecords.clear);
