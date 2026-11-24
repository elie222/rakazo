import type { ConnectorTool } from "@rakazo/adapter-kit";
import { NativeClockActions } from "@rakazo/contracts";
import * as z from "zod";

const descriptions: Record<keyof typeof NativeClockActions, string> = {
  start_phone_timer:
    "Ask the owner's current Android phone to start a countdown in its clock app. The owner confirms on that phone. A dispatched result confirms only the handoff to the clock app. If the outcome is uncertain, ask the owner to check the clock before trying again.",
  set_phone_alarm:
    "Ask the owner's current Android phone to set a one-time alarm for the next occurrence of a local hour and minute. Use 24-hour time. For an explicitly requested date, make sure it is the next occurrence or explain the limit. The owner confirms on that phone. A dispatched result confirms only the handoff to the clock app. If uncertain, ask the owner to check the clock before trying again.",
};

export const phoneClockTools: ConnectorTool[] = Object.entries(NativeClockActions).map(
  ([name, schema]) => ({
    name,
    description: descriptions[name as keyof typeof NativeClockActions],
    inputSchema: z.toJSONSchema(schema, { io: "input" }),
    readOnly: false,
  }),
);
