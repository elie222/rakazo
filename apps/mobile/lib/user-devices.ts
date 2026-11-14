import { t } from "@lingui/core/macro";
import type { UserDeviceSummary } from "@rakazo/contracts";
import { USER_DEVICE_PATH, userDeviceListSchema } from "@rakazo/contracts";
import { fetchAuthenticatedAccountJson } from "./api";

export async function listUserDevices(): Promise<UserDeviceSummary[]> {
  const { response, body } = await fetchAuthenticatedAccountJson<unknown>(USER_DEVICE_PATH, {}, {});
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(t`Could not load`);
  try {
    return userDeviceListSchema.parse(body).devices;
  } catch {
    throw new Error(t`Could not load`);
  }
}

export async function removeUserDevice(deviceId: string): Promise<void> {
  const { response } = await fetchAuthenticatedAccountJson<unknown>(
    `${USER_DEVICE_PATH}/${encodeURIComponent(deviceId)}`,
    { method: "DELETE" },
    null,
  );
  if (!response.ok && response.status !== 404) throw new Error(t`Could not remove`);
}
