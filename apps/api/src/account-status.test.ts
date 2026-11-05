import type * as Db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { AccountStatusDeps } from "./account-status.js";
import { endDeactivatedAccess } from "./account-status.js";
import { revokeUserDevices } from "./user-devices.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  cancelDeactivatedAccountRuns: vi.fn(
    async (_prisma: unknown, events: { notify(threadId: string, seq: number): Promise<void> }) => {
      await events.notify("thread-1", 4);
      return 1;
    },
  ),
}));

describe("ending a deactivated account's access", () => {
  it("tries every step when one fails, then reports the failure", async () => {
    const calls: string[] = [];
    const step = (name: string, fail = false) =>
      vi.fn(async () => {
        calls.push(name);
        if (fail) throw new Error(`${name} failed`);
        return { count: 0 };
      });
    const deps = {
      prisma: {
        session: { deleteMany: step("sessions", true) },
        callPushDevice: { deleteMany: step("call pushes") },
        messagingLinkCode: { deleteMany: step("link codes") },
        bot: { updateMany: step("screens") },
        userDevice: { findMany: vi.fn(async () => []) },
      },
      devices: { prisma: { userDevice: { findMany: vi.fn(async () => []) } }, devices: {} },
      pushTokens: { remove: step("pushes") },
      events: { notify: step("notify") },
    } as unknown as AccountStatusDeps;

    await expect(endDeactivatedAccess(deps, "user-1")).rejects.toThrow(AggregateError);
    expect(calls).toEqual(["sessions", "pushes", "call pushes", "link codes", "screens", "notify"]);
  });

  it("disconnects the other computers when one fails", async () => {
    const disconnect = vi.fn(async () => undefined);
    const store = {
      prisma: {
        userDevice: {
          findMany: vi.fn(async () => [
            { id: "device-1", sessionId: null },
            { id: "device-2", sessionId: null },
          ]),
          updateMany: vi.fn(async ({ where }: { where: { id: string } }) => {
            if (where.id === "device-1") throw new Error("unavailable");
            return { count: 1 };
          }),
        },
      },
      devices: { disconnect },
    } as unknown as Parameters<typeof revokeUserDevices>[0];

    await expect(revokeUserDevices(store, "user-1")).rejects.toThrow(AggregateError);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith("device-2", "session-ended");
  });
});
