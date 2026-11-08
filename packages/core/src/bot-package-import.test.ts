import { BOT_PACKAGE_MAX_BYTES } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  deferred,
  packagePreview,
  packageReceipt,
  recentReceipt,
} from "./bot-package.test-helpers.js";
import type { BotPackageImportState } from "./bot-package-import.js";
import { createBotPackageImport, initialBotPackageImport } from "./bot-package-import.js";

function fixture() {
  type Deps = Parameters<typeof createBotPackageImport>[0];
  let state = initialBotPackageImport;
  let epoch = 1;
  let nonceCount = 0;
  const changes: BotPackageImportState[] = [];
  const deps = {
    preview: vi.fn<Deps["preview"]>(async (input) =>
      packagePreview({ includeMemory: input.includeMemory }),
    ),
    import: vi.fn<Deps["import"]>(async () => packageReceipt()),
    status: vi.fn<Deps["status"]>(async () => packageReceipt()),
    recent: vi.fn<Deps["recent"]>(async () => [recentReceipt()]),
    resume: vi.fn<Deps["resume"]>(async () => packageReceipt()),
    cancel: vi.fn<Deps["cancel"]>(async () => packageReceipt({ status: "cancelled", botId: null })),
    newNonce: vi.fn(() => `nonce-${++nonceCount}`),
    isCurrent: () => epoch === 1,
    changed(next: BotPackageImportState) {
      state = next;
      changes.push(next);
    },
  };
  const manager = createBotPackageImport(deps);
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
  };
}

async function review(f: ReturnType<typeof fixture>, source = "{\n  source: original\n}") {
  f.manager.edit({ source });
  await f.manager.preview();
  expect(f.state.phase).toBe("review");
}

describe("bot package import review", () => {
  it("previews original text with memory off and performs no write until confirmation", async () => {
    const f = fixture();
    const source = '\uFEFF{ "instructions": "first\\r\\nnext" }\n';
    await review(f, source);
    expect(f.deps.preview).toHaveBeenCalledWith(
      { source, includeMemory: false },
      expect.any(AbortSignal),
    );
    expect(f.deps.import).not.toHaveBeenCalled();
    expect(f.deps.newNonce).not.toHaveBeenCalled();
    await f.manager.confirm();
    expect(f.deps.import).toHaveBeenCalledExactlyOnceWith(
      { previewToken: "review-token", clientNonce: "nonce-1" },
      expect.any(AbortSignal),
    );
    expect(f.state).toMatchObject({
      phase: "completed",
      source: "",
      preview: null,
      includeMemory: false,
    });
  });

  it.each([{ name: "Renamed" }, { includeMemory: true }, { source: "different package" }])(
    "requires another server preview after changing %j",
    async (patch) => {
      const f = fixture();
      await review(f);
      f.manager.edit(patch);
      expect(f.state).toMatchObject({ phase: "editing", preview: null });
      await f.manager.confirm();
      expect(f.deps.import).not.toHaveBeenCalled();
      await f.manager.preview();
      expect(f.deps.preview.mock.calls.at(-1)?.[0]).toMatchObject(patch);
    },
  );

  it("measures UTF-8 bytes before RPC rather than string characters", async () => {
    const f = fixture();
    f.manager.edit({ source: "界".repeat(Math.floor(BOT_PACKAGE_MAX_BYTES / 3) + 1) });
    await f.manager.preview();
    expect(f.state.phase).toBe("editing");
    expect(f.deps.preview).not.toHaveBeenCalled();
    f.manager.edit({ source: `${" ".repeat(BOT_PACKAGE_MAX_BYTES - 1)}x` });
    await f.manager.preview();
    expect(f.deps.preview).toHaveBeenCalledOnce();
    expect(f.state.phase).toBe("review");
  });

  it("ignores an old preview after source ABA and aborts its read", async () => {
    const f = fixture();
    const old = deferred<ReturnType<typeof packagePreview>>();
    f.deps.preview.mockImplementationOnce(() => old.promise);
    f.manager.edit({ source: "original" });
    const first = f.manager.preview();
    const signal = f.deps.preview.mock.calls[0]?.[1] as AbortSignal;
    f.manager.edit({ source: "other" });
    f.manager.edit({ source: "original" });
    f.deps.preview.mockResolvedValueOnce(packagePreview({ previewToken: "new-review" }));
    await f.manager.preview();
    old.resolve(packagePreview({ previewToken: "old-review" }));
    await first;
    expect(signal.aborted).toBe(true);
    expect(f.state.preview?.previewToken).toBe("new-review");
  });

  it("ignores a previous memory choice even when its late response is successful", async () => {
    const f = fixture();
    const old = deferred<ReturnType<typeof packagePreview>>();
    f.deps.preview.mockImplementationOnce(() => old.promise);
    f.manager.edit({ source: "package" });
    const first = f.manager.preview();
    f.manager.edit({ includeMemory: true });
    await f.manager.preview();
    old.resolve(packagePreview({ includeMemory: false }));
    await first;
    expect(f.state.preview?.includeMemory).toBe(true);
    expect(f.state.includeMemory).toBe(true);
  });

  it("refuses a preview that does not confirm the requested memory choice", async () => {
    const f = fixture();
    f.manager.edit({ source: "package", includeMemory: true });
    f.deps.preview.mockResolvedValueOnce(packagePreview({ includeMemory: false }));
    await f.manager.preview();
    await f.manager.confirm();
    expect(f.state.phase).toBe("editing");
    expect(f.deps.import).not.toHaveBeenCalled();
  });

  it.each(["1970-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"])(
    "lets the server confirm its preview despite a client clock at %s",
    async (clientTime) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(clientTime));
      try {
        const f = fixture();
        f.deps.preview.mockResolvedValueOnce(
          packagePreview({ expiresAt: "2026-11-02T00:10:00.000Z" }),
        );
        await review(f);
        await f.manager.confirm();
        expect(f.deps.import).toHaveBeenCalledExactlyOnceWith(
          { previewToken: "review-token", clientNonce: "nonce-1" },
          expect.any(AbortSignal),
        );
        expect(f.state).toMatchObject({ phase: "completed", clientNonce: "nonce-1" });
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("retains the same intent after the server rejects an expired preview until cancellation settles", async () => {
    const f = fixture();
    await review(f);
    f.deps.import.mockRejectedValueOnce(new Error("Preview expired"));
    await f.manager.confirm();
    expect(f.state).toMatchObject({ phase: "unknown", clientNonce: "nonce-1", canRetry: false });
    expect(f.state.preview?.previewToken).toBe("review-token");
    expect(f.manager.reset()).toBe(false);
    f.deps.status.mockRejectedValueOnce(new Error("Status unavailable"));
    await f.manager.check();
    await f.manager.confirm();
    expect(f.deps.import).toHaveBeenCalledOnce();
    expect(f.manager.reset()).toBe(false);
    f.deps.status.mockResolvedValueOnce(null);
    await f.manager.check();
    expect(f.state).toMatchObject({ phase: "unknown", clientNonce: "nonce-1", canRetry: true });
    expect(f.manager.reset()).toBe(false);
    await f.manager.cancel();
    expect(f.deps.cancel).toHaveBeenCalledExactlyOnceWith(
      { clientNonce: "nonce-1" },
      expect.any(AbortSignal),
    );
    expect(f.manager.reset()).toBe(true);
    expect(f.deps.newNonce).toHaveBeenCalledOnce();
  });

  it("deduplicates confirmation and locks edits when the write response is lost", async () => {
    const f = fixture();
    const write = deferred<ReturnType<typeof packageReceipt>>();
    await review(f);
    f.deps.import.mockImplementationOnce(() => write.promise);
    const pending = f.manager.confirm();
    await f.manager.confirm();
    f.manager.edit({ source: "replacement" });
    expect(f.manager.reset()).toBe(false);
    expect(f.state.source).not.toBe("replacement");
    expect(f.deps.import).toHaveBeenCalledOnce();
    expect(f.deps.newNonce).toHaveBeenCalledOnce();
    write.reject(new Error("response lost"));
    await pending;
    expect(f.state).toMatchObject({ phase: "unknown", clientNonce: "nonce-1", canRetry: false });
    await f.manager.confirm();
    await f.manager.resume();
    expect(f.deps.import).toHaveBeenCalledOnce();
    expect(f.deps.resume).not.toHaveBeenCalled();
  });

  it("keeps the original nonce locked after an absent status and replays only that intent", async () => {
    const f = fixture();
    await review(f);
    f.deps.import.mockRejectedValueOnce(new Error("response lost"));
    await f.manager.confirm();
    f.deps.status.mockRejectedValueOnce(new Error("unavailable"));
    await f.manager.check();
    await f.manager.confirm();
    expect(f.deps.import).toHaveBeenCalledOnce();
    f.deps.status.mockResolvedValueOnce(null);
    await f.manager.check();
    expect(f.state).toMatchObject({ phase: "unknown", canRetry: true, clientNonce: "nonce-1" });
    f.manager.edit({ source: "replacement" });
    expect(f.manager.reset()).toBe(false);
    await f.manager.confirm();
    expect(f.deps.import.mock.calls.map((args) => args[0])).toEqual([
      { previewToken: "review-token", clientNonce: "nonce-1" },
      { previewToken: "review-token", clientNonce: "nonce-1" },
    ]);
    expect(f.deps.newNonce).toHaveBeenCalledOnce();
    expect(f.state.phase).toBe("completed");
  });

  it("loads metadata without taking over the draft and recovers only on explicit request", async () => {
    const f = fixture();
    const recent = deferred<ReturnType<typeof recentReceipt>[]>();
    f.deps.recent.mockImplementationOnce(() => recent.promise);
    const loading = f.manager.loadRecent();
    await review(f, "new draft");
    recent.resolve([recentReceipt()]);
    await loading;
    expect(f.state).toMatchObject({ source: "new draft", phase: "review", clientNonce: null });
    expect(f.deps.status).not.toHaveBeenCalled();
    await f.manager.recover("nonce-1");
    expect(f.deps.status).toHaveBeenCalledExactlyOnceWith(
      { clientNonce: "nonce-1" },
      expect.any(AbortSignal),
    );
    expect(f.deps.import).not.toHaveBeenCalled();
    expect(f.state.phase).toBe("completed");
  });

  it("resumes an accepted immutable plan without needing the original preview token", async () => {
    const f = fixture();
    f.deps.status.mockResolvedValueOnce(packageReceipt({ status: "failed", botId: null }));
    await f.manager.recover("nonce-1");
    expect(f.state.preview).toBeNull();
    expect(f.manager.reset()).toBe(false);
    await f.manager.resume();
    expect(f.deps.resume).toHaveBeenCalledExactlyOnceWith(
      { clientNonce: "nonce-1" },
      expect.any(AbortSignal),
    );
    expect(f.deps.import).not.toHaveBeenCalled();
    expect(f.state.receipt?.botId).toBe("bot-1");
  });

  it("does not recover another nonce while an unresolved intent is owned by this screen", async () => {
    const f = fixture();
    f.deps.status.mockResolvedValueOnce(null);
    await f.manager.recover("nonce-1");
    await f.manager.recover("other-nonce");
    expect(f.deps.status).toHaveBeenCalledOnce();
    expect(f.state.clientNonce).toBe("nonce-1");
    expect(f.manager.reset()).toBe(false);
  });

  it("keeps the original review when explicitly checking the same unresolved recent import", async () => {
    const f = fixture();
    await review(f, "original source");
    f.deps.import.mockRejectedValueOnce(new Error("response lost"));
    await f.manager.confirm();
    f.deps.status.mockResolvedValueOnce(null);
    await f.manager.recover("nonce-1");
    expect(f.state.source).toBe("original source");
    expect(f.state.preview?.previewToken).toBe("review-token");
    await f.manager.confirm();
    expect(f.deps.import).toHaveBeenCalledTimes(2);
    expect(f.deps.newNonce).toHaveBeenCalledOnce();
  });

  it("does not replace a newer accepted receipt with a regressing resume response", async () => {
    const f = fixture();
    f.deps.status.mockResolvedValueOnce(
      packageReceipt({ status: "importing", botId: null, revision: 3 }),
    );
    await f.manager.recover("nonce-1");
    f.deps.resume.mockResolvedValueOnce(packageReceipt({ revision: 2 }));
    await f.manager.resume();
    expect(f.state).toMatchObject({ phase: "unknown", canRetry: false });
    expect(f.state.receipt).toMatchObject({ revision: 3, status: "importing", botId: null });
  });

  it("does not forget a previously accepted marker when a later read reports absence", async () => {
    const f = fixture();
    f.deps.status.mockResolvedValueOnce(
      packageReceipt({ status: "importing", botId: null, revision: 3 }),
    );
    await f.manager.recover("nonce-1");
    f.deps.status.mockResolvedValueOnce(null);
    await f.manager.check();
    await f.manager.resume();
    expect(f.state).toMatchObject({ phase: "unknown", canRetry: false });
    expect(f.state.receipt).toMatchObject({ status: "importing", revision: 3 });
    expect(f.deps.resume).not.toHaveBeenCalled();
  });

  it("keeps a usable review when refreshing the unrelated recent list fails", async () => {
    const f = fixture();
    await review(f);
    f.deps.recent.mockRejectedValueOnce(new Error("metadata unavailable"));
    await f.manager.loadRecent();
    expect(f.state).toMatchObject({ phase: "review", error: null, recentLoading: false });
    expect(f.state.recentError).toBeInstanceOf(Error);
    await f.manager.confirm();
    expect(f.state.phase).toBe("completed");
  });

  it("uses cancellation as a fence before allowing a new intent after an absent status", async () => {
    const f = fixture();
    f.deps.status.mockResolvedValueOnce(null);
    await f.manager.recover("nonce-1");
    const cancel = deferred<ReturnType<typeof packageReceipt>>();
    f.deps.cancel.mockImplementationOnce(() => cancel.promise);
    const cancelling = f.manager.cancel();
    expect(f.manager.reset()).toBe(false);
    cancel.resolve(packageReceipt({ status: "cancelled", botId: null, digest: "" }));
    await cancelling;
    expect(f.state.receipt?.status).toBe("cancelled");
    expect(f.manager.reset()).toBe(true);
    f.manager.edit({ source: "new intent" });
    expect(f.state.source).toBe("new intent");
  });

  it("honors a completed cancellation race and ignores the older in-flight response", async () => {
    const f = fixture();
    const write = deferred<ReturnType<typeof packageReceipt>>();
    await review(f);
    f.deps.import.mockImplementationOnce(() => write.promise);
    const importing = f.manager.confirm();
    f.deps.cancel.mockResolvedValueOnce(
      packageReceipt({ status: "completed", botId: "committed-bot" }),
    );
    await f.manager.cancel();
    write.resolve(packageReceipt({ status: "cancelled", botId: null }));
    await importing;
    expect(f.state.receipt).toMatchObject({ status: "completed", botId: "committed-bot" });
    await f.manager.cancel();
    expect(f.deps.cancel).toHaveBeenCalledOnce();
  });

  it.each([packageReceipt({ clientNonce: "another" }), packageReceipt({ digest: "b".repeat(64) })])(
    "does not publish a mismatched write receipt",
    async (receipt) => {
      const f = fixture();
      await review(f);
      f.deps.import.mockResolvedValueOnce(receipt);
      await f.manager.confirm();
      expect(f.state).toMatchObject({
        phase: "unknown",
        clientNonce: "nonce-1",
        receipt: null,
        canRetry: false,
      });
    },
  );

  it("keeps a confirmed receipt stable through redundant status actions", async () => {
    const f = fixture();
    await review(f);
    await f.manager.confirm();
    f.deps.status.mockRejectedValueOnce(new Error("later outage"));
    await f.manager.check();
    expect(f.deps.status).not.toHaveBeenCalled();
    expect(f.state.phase).toBe("completed");
  });

  it.each(["scope ABA", "dispose"])("does not publish a late preview after %s", async (change) => {
    const f = fixture();
    const request = deferred<ReturnType<typeof packagePreview>>();
    f.deps.preview.mockImplementationOnce(() => request.promise);
    f.manager.edit({ source: "package" });
    const loading = f.manager.preview();
    if (change === "dispose") f.manager.dispose();
    else {
      f.switchScope();
      f.switchScope();
    }
    const count = f.changes.length;
    request.resolve(packagePreview());
    await loading;
    expect(f.changes).toHaveLength(count);
    expect(f.deps.import).not.toHaveBeenCalled();
  });

  it.each(["scope ABA", "dispose"])(
    "does not publish a committed receipt in an old screen after %s",
    async (change) => {
      const f = fixture();
      const receipt = deferred<ReturnType<typeof packageReceipt>>();
      await review(f);
      f.deps.import.mockImplementationOnce(() => receipt.promise);
      const importing = f.manager.confirm();
      if (change === "dispose") f.manager.dispose();
      else {
        f.switchScope();
        f.switchScope();
      }
      const count = f.changes.length;
      receipt.resolve(packageReceipt());
      await importing;
      expect(f.changes).toHaveLength(count);
      expect(f.deps.import).toHaveBeenCalledOnce();
    },
  );

  it("does not publish late metadata after disposal", async () => {
    const f = fixture();
    const recent = deferred<ReturnType<typeof recentReceipt>[]>();
    f.deps.recent.mockImplementationOnce(() => recent.promise);
    const loading = f.manager.loadRecent();
    f.manager.dispose();
    const count = f.changes.length;
    recent.resolve([recentReceipt()]);
    await loading;
    expect(f.changes).toHaveLength(count);
  });
});
