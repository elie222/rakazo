import type { UserDeviceSummary } from "@rakazo/contracts";
import { USER_DEVICE_PATH, userDeviceListSchema } from "@rakazo/contracts";

export type UserDeviceRequest = (
  path: string,
  method: "GET" | "DELETE",
) => Promise<{
  ok: boolean;
  status: number;
  readBody: () => Promise<unknown>;
}>;

export async function listUserDevicesWith(
  request: UserDeviceRequest,
  failureMessage: string,
): Promise<UserDeviceSummary[]> {
  const response = await request(USER_DEVICE_PATH, "GET");
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(failureMessage);
  try {
    return userDeviceListSchema.parse(await response.readBody()).devices;
  } catch {
    throw new Error(failureMessage);
  }
}

export async function removeUserDeviceWith(
  request: UserDeviceRequest,
  deviceId: string,
  failureMessage: string,
): Promise<void> {
  const response = await request(`${USER_DEVICE_PATH}/${encodeURIComponent(deviceId)}`, "DELETE");
  if (!response.ok && response.status !== 404) throw new Error(failureMessage);
}
