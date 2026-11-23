import { USER_DEVICE_PATH } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { listUserDevices, removeUserDevice } from "./user-devices";

const fetchAuthenticatedAccountJson = vi.fn();

vi.mock("../api/api", () => ({
  fetchAuthenticatedAccountJson: (...args: unknown[]) => fetchAuthenticatedAccountJson(...args),
}));

afterEach(() => {
  fetchAuthenticatedAccountJson.mockReset();
});

it("lists paired computers and treats a missing route as none", async () => {
  fetchAuthenticatedAccountJson.mockResolvedValueOnce({
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
  expect(fetchAuthenticatedAccountJson).toHaveBeenCalledWith(USER_DEVICE_PATH, {}, {});

  fetchAuthenticatedAccountJson.mockResolvedValueOnce({
    response: { ok: false, status: 404 },
    body: {},
  });
  await expect(listUserDevices()).resolves.toEqual([]);
});

it("does not expose a bad list payload", async () => {
  fetchAuthenticatedAccountJson.mockResolvedValueOnce({
    response: { ok: true, status: 200 },
    body: { devices: "nope" },
  });
  await expect(listUserDevices()).rejects.toThrow("Could not load");
});

it("reports a failed list and a failed revoke, and ignores an already-removed computer", async () => {
  fetchAuthenticatedAccountJson.mockResolvedValueOnce({
    response: { ok: false, status: 500 },
    body: {},
  });
  await expect(listUserDevices()).rejects.toThrow("Could not load");

  fetchAuthenticatedAccountJson.mockResolvedValueOnce({
    response: { ok: true, status: 204 },
    body: null,
  });
  await expect(removeUserDevice("d2")).resolves.toBeUndefined();
  expect(fetchAuthenticatedAccountJson).toHaveBeenLastCalledWith(
    `${USER_DEVICE_PATH}/d2`,
    {
      method: "DELETE",
    },
    null,
  );

  fetchAuthenticatedAccountJson.mockResolvedValueOnce({
    response: { ok: false, status: 404 },
    body: null,
  });
  await expect(removeUserDevice("gone")).resolves.toBeUndefined();

  fetchAuthenticatedAccountJson.mockResolvedValueOnce({
    response: { ok: false, status: 500 },
    body: null,
  });
  await expect(removeUserDevice("d2")).rejects.toThrow("Could not remove");
});

it("encodes a computer id in the revoke URL", async () => {
  fetchAuthenticatedAccountJson.mockResolvedValueOnce({
    response: { ok: true, status: 204 },
    body: null,
  });
  await removeUserDevice("desk/pc");
  expect(fetchAuthenticatedAccountJson.mock.calls[0]?.[0]).toBe(`${USER_DEVICE_PATH}/desk%2Fpc`);
});
