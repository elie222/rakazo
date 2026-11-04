import type * as Db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { AccountStatusDeps } from "./account-status.js";
import { endDeactivatedAccess } from "./account-status.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  cancelDeactivatedAccountRuns: vi.fn(async () => [{ threadId: "thread-1", seq: 4 }]),
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
        bot: { updateMany: step("screens") },
        userDevice: { findMany: vi.fn(async () => []) },
      },
      devices: { prisma: { userDevice: { findMany: vi.fn(async () => []) } }, devices: {} },
      pushTokens: { remove: step("pushes") },
      events: { notify: step("notify") },
    } as unknown as AccountStatusDeps;

    await expect(endDeactivatedAccess(deps, "user-1")).rejects.toThrow(AggregateError);
    expect(calls).toEqual(["sessions", "pushes", "call pushes", "screens", "notify"]);
  });
});
