import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const lstatRace = vi.hoisted(() => ({
  after: undefined as undefined | ((target: string) => Promise<void>),
  afterRealpath: undefined as undefined | ((target: string) => Promise<void>),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    constants: { ...actual.constants, O_NOFOLLOW: 0 },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (target: string, options?: { bigint?: boolean }) => {
      const result = await actual.lstat(target, options as never);
      await lstatRace.after?.(target);
      return result;
    },
    realpath: async (target: string) => {
      const result = await actual.realpath(target);
      await lstatRace.afterRealpath?.(target);
      return result;
    },
  };
});

const { DesktopSandboxProvider } = await import("./desktop-sandbox.js");

const ctx = {
  operationId: "operation",
  traceId: "trace",
  workspaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const roots: string[] = [];

afterEach(async () => {
  lstatRace.after = undefined;
  lstatRace.afterRealpath = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(botId: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-desktop-containment-")));
  roots.push(root);
  const desktop = new DesktopSandboxProvider({ root });
  const computer = await desktop.provision({ botId, homePath: "/unused" }, ctx);
  return { root, desktop, computer };
}

describe("desktop sandbox write containment without O_NOFOLLOW", () => {
  it("rejects an existing final symlink without changing its outside target", async () => {
    const { root, desktop, computer } = await fixture("static-link");
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "before");
    await symlink(outside, path.join(computer.providerRef, "escape.txt"));

    await expect(
      desktop.writeFile(computer, {
        path: "escape.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("before");
  });

  it("does not write outside when the final file is replaced after lstat", async () => {
    const { root, desktop, computer } = await fixture("swap-link");
    const target = path.join(computer.providerRef, "result.txt");
    const displaced = path.join(computer.providerRef, "result-original.txt");
    const outside = path.join(root, "outside.txt");
    await writeFile(target, "inside-before");
    await writeFile(outside, "outside-before");
    let swapped = false;
    lstatRace.after = async (inspected) => {
      if (swapped || path.resolve(inspected) !== target) return;
      swapped = true;
      await rename(target, displaced);
      await symlink(outside, target);
    };

    await expect(
      desktop.writeFile(computer, {
        path: "result.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    expect(swapped).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside-before");
    expect(await readFile(displaced, "utf8")).toBe("inside-before");
  });

  it("rejects a parent symlink that resolves outside the workspace", async () => {
    const { root, desktop, computer } = await fixture("parent-link");
    const outside = path.join(root, "outside-directory");
    await mkdir(outside);
    await symlink(outside, path.join(computer.providerRef, "escape-directory"), "junction");

    await expect(
      desktop.writeFile(computer, {
        path: "escape-directory/outside.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    await expect(readFile(path.join(outside, "outside.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not write outside when a validated parent is replaced before open", async () => {
    const { root, desktop, computer } = await fixture("parent-swap");
    const parent = path.join(computer.providerRef, "notes");
    const displaced = path.join(computer.providerRef, "notes-original");
    const outside = path.join(root, "outside-directory");
    await mkdir(parent);
    await mkdir(outside);
    await writeFile(path.join(parent, "result.txt"), "inside-before");
    await writeFile(path.join(outside, "result.txt"), "outside-before");
    let swapped = false;
    lstatRace.afterRealpath = async (inspected) => {
      if (swapped || path.resolve(inspected) !== parent) return;
      swapped = true;
      await rename(parent, displaced);
      await symlink(outside, parent, "junction");
    };

    await expect(
      desktop.writeFile(computer, {
        path: "notes/result.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    expect(swapped).toBe(true);
    expect(await readFile(path.join(outside, "result.txt"), "utf8")).toBe("outside-before");
    expect(await readFile(path.join(displaced, "result.txt"), "utf8")).toBe("inside-before");
  });

  it("rejects a hard link whose other name is outside the workspace", async () => {
    const { root, desktop, computer } = await fixture("hard-link");
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside-before");
    await link(outside, path.join(computer.providerRef, "escape.txt"));

    await expect(
      desktop.writeFile(computer, {
        path: "escape.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("outside-before");
  });

  it("still creates and replaces ordinary workspace files", async () => {
    const { desktop, computer } = await fixture("ordinary-files");

    await desktop.writeFile(computer, {
      path: "notes/result.txt",
      content: new TextEncoder().encode("first"),
    });
    await desktop.writeFile(computer, {
      path: "notes/result.txt",
      content: new TextEncoder().encode("second"),
    });

    expect(await readFile(path.join(computer.providerRef, "notes/result.txt"), "utf8")).toBe(
      "second",
    );
  });
});
