import { t } from "@lingui/core/macro";
import type { UserDeviceRequest } from "@rakazo/core";
import { listUserDevicesWith, readBoundedJsonResponse, removeUserDeviceWith } from "@rakazo/core";

const request: UserDeviceRequest = async (path, method) => {
  const response = await fetch(path, {
    ...(method === "DELETE" ? { method } : {}),
    signal: AbortSignal.timeout(8_000),
  });
  if (method === "DELETE") await response.body?.cancel();
  return {
    ok: response.ok,
    status: response.status,
    readBody: () => readBoundedJsonResponse<unknown>(response, 64 * 1024),
  };
};

export function listUserDevices() {
  return listUserDevicesWith(request, t`Could not load`);
}

export function removeUserDevice(deviceId: string) {
  return removeUserDeviceWith(request, deviceId, t`Could not remove`);
}
