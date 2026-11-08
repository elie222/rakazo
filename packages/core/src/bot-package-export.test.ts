import type { BotPackageExport } from "@rakazo/contracts";
import { BOT_PACKAGE_MAX_BYTES } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { deferred, packageDocument, packageExport } from "./bot-package.test-helpers.js";
import type { BotPackageExportState } from "./bot-package-export.js";
import { createBotPackageExport, initialBotPackageExport } from "./bot-package-export.js";

function fixture() {
  type Deps = Parameters<typeof createBotPackageExport>[0];
  let state = initialBotPackageExport;
  let epoch = 1;
  const changes: BotPackageExportState[] = [];
  let onChange: ((next: BotPackageExportState) => void) | null = null;
  const deps = {
    export: vi.fn<Deps["export"]>(async () => packageExport()),
    deliver: vi.fn<Deps["deliver"]>(async () => {}),
    isCurrent: () => epoch === 1,
    changed(next: BotPackageExportState) {
      state = next;
      changes.push(next);
      onChange?.(next);
    },
  };
  const manager = createBotPackageExport(deps);
  return {
    manager,
    deps,
    changes,
    get state() {
      return state;
    },
    switchScope() {
      epoch++;
    },
    onChange(callback: (next: BotPackageExportState) => void) {
      onChange = callback;
    },
  };
}
const input = { botId: "bot-1", skillIds: [], includeMemory: false };

describe("bot package export delivery", () => {
  it("prepares explicit options without delivery, then confirms the exact bounded result once", async () => {
    const f = fixture();
    await f.manager.run(input);
    expect(f.deps.export).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal));
    expect(f.state.phase).toBe("review");
    expect(f.deps.deliver).not.toHaveBeenCalled();
    await f.manager.confirm();
    await f.manager.confirm();
    expect(f.deps.deliver).toHaveBeenCalledExactlyOnceWith(
      packageExport(),
      expect.any(AbortSignal),
    );
    expect(f.state.phase).toBe("completed");
  });

  it("snapshots selected skill IDs before publishing progress", async () => {
    const f = fixture();
    const selected = { ...input, skillIds: ["selected-skill"] };
    f.onChange((next) => {
      if (next.phase === "exporting") selected.skillIds.push("later-skill");
    });
    await f.manager.run(selected);
    expect(f.deps.export.mock.calls[0]?.[0].skillIds).toEqual(["selected-skill"]);
  });

  it.each(["scope ABA", "dispose"])("does not deliver a late export after %s", async (change) => {
    const f = fixture();
    const result = deferred<BotPackageExport>();
    f.deps.export.mockImplementationOnce(() => result.promise);
    const exporting = f.manager.run(input);
    if (change === "dispose") f.manager.dispose();
    else {
      f.switchScope();
      f.switchScope();
    }
    const count = f.changes.length;
    result.resolve(packageExport());
    await exporting;
    expect(f.deps.deliver).not.toHaveBeenCalled();
    expect(f.changes).toHaveLength(count);
  });

  it("delivers only the latest requested export when a prior read resolves later", async () => {
    const f = fixture();
    const old = deferred<BotPackageExport>();
    f.deps.export.mockImplementationOnce(() => old.promise);
    const first = f.manager.run(input);
    const latest = packageExport({
      document: { ...packageDocument, profile: { ...packageDocument.profile, name: "Latest" } },
    });
    f.deps.export.mockResolvedValueOnce(latest);
    await f.manager.run({ ...input, includeMemory: true });
    old.resolve(packageExport());
    await first;
    expect(f.deps.deliver).not.toHaveBeenCalled();
    await f.manager.confirm();
    expect(f.deps.deliver).toHaveBeenCalledExactlyOnceWith(latest, expect.any(AbortSignal));
  });

  it("checks UTF-8 result size before any platform write or handoff", async () => {
    const f = fixture();
    f.deps.export.mockResolvedValueOnce(
      packageExport({ json: "界".repeat(Math.floor(BOT_PACKAGE_MAX_BYTES / 3) + 1) }),
    );
    await f.manager.run(input);
    expect(f.deps.deliver).not.toHaveBeenCalled();
    expect(f.state.phase).toBe("error");
  });

  it("rechecks scope after rendering the delivery state", async () => {
    const f = fixture();
    f.onChange((next) => {
      if (next.phase === "delivering") f.switchScope();
    });
    await f.manager.run(input);
    await f.manager.confirm();
    expect(f.deps.deliver).not.toHaveBeenCalled();
  });

  it("does not duplicate an in-progress platform handoff or claim completion after disposal", async () => {
    const f = fixture();
    const delivery = deferred<void>();
    f.deps.deliver.mockImplementationOnce(() => delivery.promise);
    await f.manager.run(input);
    const first = f.manager.confirm();
    expect(f.state.phase).toBe("delivering");
    await f.manager.run({ ...input, includeMemory: true });
    expect(f.deps.export).toHaveBeenCalledOnce();
    expect(f.deps.deliver).toHaveBeenCalledOnce();
    f.manager.dispose();
    const count = f.changes.length;
    delivery.resolve();
    await first;
    expect(f.changes).toHaveLength(count);
  });

  it("reports failed delivery without claiming an OS consumer received the file", async () => {
    const f = fixture();
    f.deps.deliver.mockRejectedValueOnce(new Error("share unknown"));
    await f.manager.run(input);
    await f.manager.confirm();
    await f.manager.confirm();
    expect(f.deps.deliver).toHaveBeenCalledOnce();
    expect(f.state).toMatchObject({ phase: "error", result: null });
    expect(f.changes.some((state) => state.phase === "completed")).toBe(false);
  });

  it("does not invoke delivery when the server export fails", async () => {
    const f = fixture();
    f.deps.export.mockRejectedValueOnce(new Error("not allowed"));
    await f.manager.run(input);
    expect(f.deps.deliver).not.toHaveBeenCalled();
    expect(f.state.phase).toBe("error");
  });

  it.each(["scope", "dispose", "options"])(
    "cannot confirm a review invalidated by %s",
    async (change) => {
      const f = fixture();
      await f.manager.run(input);
      if (change === "scope") f.switchScope();
      else if (change === "dispose") f.manager.dispose();
      else f.manager.invalidate();
      await f.manager.confirm();
      expect(f.deps.deliver).not.toHaveBeenCalled();
    },
  );

  it("invalidates a pending preparation and ignores its late reply", async () => {
    const f = fixture();
    const result = deferred<BotPackageExport>();
    f.deps.export.mockImplementationOnce(() => result.promise);
    const pending = f.manager.run(input);
    f.manager.invalidate();
    result.resolve(packageExport());
    await pending;
    await f.manager.confirm();
    expect(f.state.phase).toBe("idle");
    expect(f.deps.deliver).not.toHaveBeenCalled();
  });
});
