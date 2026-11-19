import { RoutineWatchSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RoutineWatchDeps } from "./routine-watch.js";
import { validateRoutineWatch } from "./routine-watch.js";
import { resolveWatchArgs } from "./routine-watch-args.js";

it("validates a tool watch with the dates a check would send", async () => {
  const resolveCall = vi.fn(async (call: { tool: string; args: Record<string, unknown> }) => ({
    call,
    tool: { name: call.tool, readOnly: true },
  }));
  const deps = {
    connector: { discoverTools: vi.fn(async () => []), resolveCall },
  } as unknown as RoutineWatchDeps;
  const watch = RoutineWatchSchema.parse({
    kind: "tool",
    tool: "calendar_list_events",
    args: { from: "{{today}}", calendar: "primary" },
  });
  await validateRoutineWatch(deps, watch, { spaceId: "s", userId: "u", botId: "b" });
  expect(resolveCall.mock.calls[0]?.[0].args).toEqual({
    from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    calendar: "primary",
  });
});

describe("resolveWatchArgs", () => {
  const now = new Date("2026-03-10T03:30:00Z");

  it("sends a relative day as that calendar day in the routine's timezone", () => {
    expect(
      resolveWatchArgs(
        { from: "{{today}}", to: "{{today+2d}}", since: "{{today-7d}}" },
        now,
        "America/Chicago",
      ),
    ).toEqual({ from: "2026-03-09", to: "2026-03-11", since: "2026-03-02" });
    expect(resolveWatchArgs({ from: "{{today}}" }, now)).toEqual({ from: "2026-03-10" });
  });

  it("reaches nested arguments and crosses a month end", () => {
    expect(
      resolveWatchArgs(
        { params: { due_before: "{{today+30d}}", ids: ["{{today}}", 4] } },
        now,
        "UTC",
      ),
    ).toEqual({ params: { due_before: "2026-04-09", ids: ["2026-03-10", 4] } });
  });

  it("stops at a fixed depth, so arguments nested without end cost nothing to check", () => {
    let deep: Record<string, unknown> = { day: "{{today}}" };
    for (let level = 0; level < 20_000; level += 1) deep = { inner: deep };
    const resolved = resolveWatchArgs({ day: "{{today}}", deep }, now, "UTC");
    expect(resolved.day).toBe("2026-03-10");
    let leaf = resolved.deep as Record<string, unknown>;
    while (leaf.inner) leaf = leaf.inner as Record<string, unknown>;
    expect(leaf.day).toBe("{{today}}");
  });

  it("leaves everything else as saved", () => {
    const args = { q: "due {{today}}", marker: "{{tomorrow}}", limit: 5, open: true, none: null };
    expect(resolveWatchArgs(args, now, "UTC")).toEqual(args);
  });
});
