import { describe, expect, it, vi } from "vitest";
import { cleanupActors, type EvalApp } from "./runner.js";

function fixture(failDisable = false, failStop = false) {
  const order: string[] = [];
  const updateMany = vi.fn(async () => {
    order.push("disable");
    if (failDisable) throw new Error("database unavailable");
    return { count: 2 };
  });
  const request = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { json: { botId: string } };
    order.push(body.json.botId);
    return Response.json({ json: { ok: true } }, { status: failStop ? 500 : 200 });
  });
  return {
    handles: { app: { request }, prisma: { routine: { updateMany } } } as unknown as EvalApp,
    order,
    updateMany,
    request,
  };
}
const actors = [
  { botId: "first-workspace-bot", cookie: "first-session" },
  { botId: "second-workspace-bot", cookie: "second-session" },
];

describe("eval trial isolation", () => {
  it("disables recurring work before stopping every workspace with its own session", async () => {
    const f = fixture();
    await cleanupActors(f.handles, actors);
    expect(f.order).toEqual(["disable", ...actors.map((actor) => actor.botId)]);
    expect(f.updateMany).toHaveBeenCalledWith({
      where: { botId: { in: actors.map((actor) => actor.botId) } },
      data: { active: false, nextRunAt: null },
    });
    expect(
      f.request.mock.calls.map(([, init]) => new Headers(init?.headers).get("cookie")),
    ).toEqual(actors.map((actor) => actor.cookie));
  });
  it.each([
    [true, false],
    [false, true],
  ])(
    "attempts every cancellation but fails cleanup when disabling=%s or stopping=%s fails",
    async (failDisable, failStop) => {
      const f = fixture(failDisable, failStop);
      await expect(cleanupActors(f.handles, actors)).rejects.toThrow("could not be stopped");
      expect(f.order).toEqual(["disable", ...actors.map((actor) => actor.botId)]);
    },
  );
});
