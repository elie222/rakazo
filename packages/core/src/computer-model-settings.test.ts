import { expect, it, vi } from "vitest";
import { createComputerModelSettings } from "./computer-model-settings.js";

const empty = { selection: null, options: [] };
it("loads explicitly, prevents edits on failure and retries", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(empty);
  const save = vi.fn();
  const c = createComputerModelSettings({ load, save }, "load");
  expect(c.snapshot().busy).toBe(true);
  await c.load();
  expect(c.snapshot()).toMatchObject({ busy: false, stale: true, error: "offline" });
  await c.save({ mode: "main" });
  expect(save).not.toHaveBeenCalled();
  await c.load();
  expect(c.snapshot()).toMatchObject({ view: empty, stale: false, error: null });
});
it("uses persisted readback, and never shows a failed write as saved", async () => {
  const save = vi
    .fn()
    .mockResolvedValueOnce({ ...empty, selection: { mode: "main" } })
    .mockRejectedValueOnce(new Error("save failed"));
  const c = createComputerModelSettings({ load: async () => empty, save }, "save");
  await c.load();
  await c.save({ mode: "main" });
  expect(c.snapshot().view?.selection).toEqual({ mode: "main" });
  await c.save(null);
  expect(c.snapshot()).toMatchObject({
    stale: true,
    error: "save failed",
    view: { selection: { mode: "main" } },
  });
});
it("ignores older responses and carries only a target's own writes across remount", async () => {
  let finish!: (value: typeof empty) => void;
  const load = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    )
    .mockResolvedValue({ ...empty, selection: { mode: "main" } });
  const c = createComputerModelSettings({ load, save: vi.fn() }, "generation");
  const first = c.load();
  await Promise.resolve();
  await c.load();
  finish(empty);
  await first;
  expect(c.snapshot().view?.selection).toEqual({ mode: "main" });
});
