import { describe, expect, it, vi } from "vitest";
import { createLocalComputerChoice, saveLocalComputerHost } from "./local-settings.js";

const target = { origin: "http://127.0.0.1:5173", token: "ab".repeat(32) };
describe("native computer host transport", () => {
  it("uses only the local capability and refuses a remote origin", async () => {
    const request = vi.fn(async () => new Response('{"ok":true}'));
    await saveLocalComputerHost(target, "this-mac", request);
    expect(request).toHaveBeenCalledWith(
      `${target.origin}/api/desktop-settings/computer-host`,
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        body: '{"computerHost":"this-mac"}',
      }),
    );
    request.mockClear();
    await expect(
      saveLocalComputerHost({ ...target, origin: "https://example.test" }, "this-mac", request),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("reports an unsuccessful save so native main can revoke a newly granted permission", async () => {
    await expect(
      saveLocalComputerHost(target, "this-mac", async () => new Response("", { status: 403 })),
    ).rejects.toThrow("Could not save local computer choice");
  });
});

describe("local computer choice", () => {
  function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("ends native access before the save finishes and refreshes once both settle", async () => {
    const events: string[] = [];
    const save = deferred();
    const choice = createLocalComputerChoice({
      save: async (host) => {
        events.push(`save ${host}`);
        await save.promise;
      },
      revoke: async () => {
        events.push("revoke");
      },
      settled: () => events.push("settled"),
    });
    const revoking = choice.revoke();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["revoke", "save docker"]);
    save.resolve();
    await revoking;
    expect(events).toEqual(["revoke", "save docker", "settled"]);
  });

  it("refreshes and reports a failed save", async () => {
    const settled = vi.fn();
    const choice = createLocalComputerChoice({
      save: async () => {
        throw new Error("Local server is unavailable");
      },
      revoke: async () => undefined,
      settled,
    });
    await expect(choice.revoke()).rejects.toThrow("Local server is unavailable");
    expect(settled).toHaveBeenCalledOnce();
  });

  it("saves a revoke after a grant still saving", async () => {
    const saved: string[] = [];
    const grant = deferred();
    const choice = createLocalComputerChoice({
      save: async (host) => {
        if (host === "this-mac") await grant.promise;
        saved.push(host);
      },
      revoke: async () => undefined,
      settled: () => undefined,
    });
    const granting = choice.persist("this-mac");
    const revoking = choice.revoke();
    grant.resolve();
    await Promise.all([granting, revoking]);
    expect(saved).toEqual(["this-mac", "docker"]);
  });
});
