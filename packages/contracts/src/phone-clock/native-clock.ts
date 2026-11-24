import * as z from "zod";
import {
  CalendarFailure,
  CalendarOperation,
  CalendarResponse,
  NativeCalendarRequest,
} from "../personal-calendar/personal-calendar.js";

const label = z.string().trim().min(1).max(80).optional();

export const NativeClockActions = {
  start_phone_timer: z.strictObject({
    durationSeconds: z.number().int().min(1).max(86_400),
    label,
  }),
  set_phone_alarm: z.strictObject({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    label,
  }),
};

export const NativeClockOperation = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start_phone_timer"),
    input: NativeClockActions.start_phone_timer,
  }),
  z.strictObject({
    action: z.literal("set_phone_alarm"),
    input: NativeClockActions.set_phone_alarm,
  }),
]);
export type NativeClockOperation = z.infer<typeof NativeClockOperation>;

const ClockDispatched = z.strictObject({ status: z.literal("dispatched") });
export const NativeClockResponse = z.union([ClockDispatched, CalendarFailure]);
export type NativeClockResponse = z.infer<typeof NativeClockResponse>;

export const NativeDeviceOperation = z.union([CalendarOperation, NativeClockOperation]);
export type NativeDeviceOperation = z.infer<typeof NativeDeviceOperation>;
export const NativeDeviceResponse = z.union([CalendarResponse, ClockDispatched]);
export type NativeDeviceResponse = z.infer<typeof NativeDeviceResponse>;
export const NativeDeviceRequest = NativeCalendarRequest.extend({
  operation: NativeDeviceOperation,
});
export type NativeDeviceRequest = z.infer<typeof NativeDeviceRequest>;

export function isNativeClockOperation(
  operation: NativeDeviceOperation,
): operation is NativeClockOperation {
  return Object.hasOwn(NativeClockActions, operation.action);
}
