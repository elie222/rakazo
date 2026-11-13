import { t } from "@lingui/core/macro";
import type { UserDeviceSummary } from "@rakazo/contracts";
import { USER_DEVICE_PATH, userDeviceListSchema } from "@rakazo/contracts";
import { captureApiRequestContext, fetchMobileJson } from "./api";

export async function listUserDevices(): Promise<UserDeviceSummary[]> {
  const context = await captureApiRequestContext();
  const { response, body } = await fetchMobileJson<unknown>(
    `${context.apiBase}${USER_DEVICE_PATH}`,
    { headers: { origin: "rakazo://", ...context.headers } },
    {},
  );
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(t`Could not load`);
  try {
    return userDeviceListSchema.parse(body).devices;
  } catch {
    throw new Error(t`Could not load`);
  }
}

export async function removeUserDevice(deviceId: string): Promise<void> {
  const context = await captureApiRequestContext();
  const { response } = await fetchMobileJson<unknown>(
    `${context.apiBase}${USER_DEVICE_PATH}/${encodeURIComponent(deviceId)}`,
    { method: "DELETE", headers: { origin: "rakazo://", ...context.headers } },
    null,
  );
  if (!response.ok && response.status !== 404) throw new Error(t`Could not remove`);
}
