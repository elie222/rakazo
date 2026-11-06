import type { ProductEvent } from "@rakazo/contracts";
import { createToolCallRecordStore } from "@rakazo/core";

const store = createToolCallRecordStore();

/** Applies a thread event to the live records; events that say nothing about a call are ignored. */
export function recordToolCallEvent(event: ProductEvent): void {
  store.record(event);
}

export const liveToolCallRecords = store.get;
export const subscribeToolCallRecords = store.subscribe;
export const clearToolCallRecords = store.clear;
