import { USER_DEVICE_PATH } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { listUserDevices, removeUserDevice } from "./user-devices";

const fetchMobileJson = vi.fn();

vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    headers: { authorization: "Bearer test-token" },
  }),
  fetchMobileJson: (...args: unknown[]) => fetchMobileJson(...args),
}));

afterEach(() => {
  fetchMobileJson.mockReset();
});

it("lists paired computers and treats a missing route as none", async () => {
  fetchMobileJson.mockResolvedValueOnce({
    response: { ok: true, status: 200 },
    body: {
      devices: [
        { deviceId: "d1", name: "Laptop", connected: true },
        { deviceId: "d2", name: "Desk PC", connected: false },
      ],
    },
  });
  await expect(listUserDevices()).resolves.toEqual([
    { deviceId: "d1", name: "Laptop", connected: true },
    { deviceId: "d2", name: "Desk PC", connected: false },
  ]);
  expect(fetchMobileJson).toHaveBeenCalledWith(
    `https://app.example.test${USER_DEVICE_PATH}`,
    { headers: { origin: "rakazo://", authorization: "Bearer test-token" } },
    {},
  );

  fetchMobileJson.mockResolvedValueOnce({ response: { ok: false, status: 404 }, body: {} });
  await expect(listUserDevices()).resolves.toEqual([]);
});

it("does not expose a bad list payload", async () => {
  fetchMobileJson.mockResolvedValueOnce({
    response: { ok: true, status: 200 },
    body: { devices: "nope" },
  });
  await expect(listUserDevices()).rejects.toThrow("Could not load");
});

it("reports a failed list and a failed revoke, and ignores an already-removed computer", async () => {
  fetchMobileJson.mockResolvedValueOnce({ response: { ok: false, status: 500 }, body: {} });
  await expect(listUserDevices()).rejects.toThrow("Could not load");

  fetchMobileJson.mockResolvedValueOnce({ response: { ok: true, status: 204 }, body: null });
  await expect(removeUserDevice("d2")).resolves.toBeUndefined();
  expect(fetchMobileJson).toHaveBeenLastCalledWith(
    `https://app.example.test${USER_DEVICE_PATH}/d2`,
    {
      method: "DELETE",
      headers: { origin: "rakazo://", authorization: "Bearer test-token" },
    },
    null,
  );

  fetchMobileJson.mockResolvedValueOnce({ response: { ok: false, status: 404 }, body: null });
  await expect(removeUserDevice("gone")).resolves.toBeUndefined();

  fetchMobileJson.mockResolvedValueOnce({ response: { ok: false, status: 500 }, body: null });
  await expect(removeUserDevice("d2")).rejects.toThrow("Could not remove");
});

it("encodes a computer id in the revoke URL", async () => {
  fetchMobileJson.mockResolvedValueOnce({ response: { ok: true, status: 204 }, body: null });
  await removeUserDevice("desk/pc");
  expect(fetchMobileJson.mock.calls[0]?.[0]).toBe(
    `https://app.example.test${USER_DEVICE_PATH}/desk%2Fpc`,
  );
});
