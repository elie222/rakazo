import { describe, expect, it, vi } from "vitest";
import { createAppOpener } from "./app-opener.js";

function deferred() {
  let resolve!: (opened: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("app opener", () => {
  it("lets a reopen join the launch already in flight", async () => {
    const launch = deferred();
    const openOnce = vi.fn(() => launch.promise);
    const opener = createAppOpener(openOnce);

    const first = opener.open("https://saved.example.test");
    const second = opener.open("https://saved.example.test");
    launch.resolve(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(openOnce).toHaveBeenCalledOnce();
    expect(opener.busy()).toBe(false);
  });

  it("never hands a pending launch's result to a server switch", async () => {
    const launch = deferred();
    const openOnce = vi.fn((_url: string, _switching: boolean) => launch.promise);
    const opener = createAppOpener(openOnce);

    const launched = opener.open("https://saved.example.test");
    expect(opener.busy()).toBe(true);
    const switched = opener.open("https://new.example.test", { switching: true });
    launch.resolve(true);

    await expect(switched).resolves.toBe(false);
    await expect(launched).resolves.toBe(true);
    expect(openOnce).toHaveBeenCalledExactlyOnceWith("https://saved.example.test", false);
  });

  it("runs a switch with its own check once nothing else is opening", async () => {
    const openOnce = vi.fn(async (_url: string, _switching: boolean) => true);
    const opener = createAppOpener(openOnce);

    await expect(opener.open("https://new.example.test", { switching: true })).resolves.toBe(true);
    expect(openOnce).toHaveBeenCalledExactlyOnceWith("https://new.example.test", true);
  });
});
