import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  listInsideHostRoots,
  openInsideHostRoots,
  readFileInsideHostRoots,
  writeFileInsideHostRoots,
} from "./host-disk-path.js";
import {
  hostDiskAccessAllowed,
  loadHostDiskSettings,
  saveHostDiskSettings,
  updateHostDiskSettings,
} from "./host-disk-settings.js";
import { HOST_DISK_TOOL_NAMES, selectHostDiskTools } from "./host-disk-tools.js";
import { LocalHostDiskProvider } from "./local-host-disk.js";
import { UnavailableHostDiskProvider } from "./unavailable-host-disk.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-host-disk-"));
  dirs.push(dir);
  return dir;
}

function adapterContext() {
  return {
    operationId: "op-1",
    traceId: "trace-1",
    spaceId: "space-1",
    userId: "user-1",
    signal: new AbortController().signal,
  };
}

describe("host disk deny by default", () => {
  it("keeps host tools out of the always-on builtin catalog", () => {
    const names = new Set(builtinAgentTools.map((tool) => tool.name));
    for (const name of HOST_DISK_TOOL_NAMES) {
      expect(names.has(name)).toBe(false);
    }
  });

  it("selectHostDiskTools returns nothing until access is enabled", () => {
    expect(selectHostDiskTools(false)).toEqual([]);
    expect(selectHostDiskTools(true).map((tool) => tool.name)).toEqual([
      "list_host_files",
      "read_host_file",
      "write_host_file",
      "copy_to_host",
      "copy_from_host",
    ]);
  });

  it("persists settings off by default with no roots", async () => {
    const dataDir = await tempDir();
    const settings = await loadHostDiskSettings(dataDir, "user-1");
    expect(settings).toEqual({ enabled: false, roots: [], clientSeenAt: null });
    expect(hostDiskAccessAllowed(settings)).toBe(false);
  });

  it("serializes concurrent settings updates so heartbeat and setRoots both stick", async () => {
    const dataDir = await tempDir();
    await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: ["/tmp/a"],
      clientSeenAt: null,
    });

    let releaseRoots!: () => void;
    const rootsGate = new Promise<void>((resolve) => {
      releaseRoots = resolve;
    });

    const rootsUpdate = updateHostDiskSettings(dataDir, "user-1", async (current) => {
      await rootsGate;
      return { ...current, roots: ["/tmp/b"] };
    });

    // Start after rootsUpdate is queued so heartbeat runs second on the chain.
    await Promise.resolve();
    const heartbeatUpdate = updateHostDiskSettings(dataDir, "user-1", (current) => ({
      ...current,
      clientSeenAt: "2026-01-01T00:00:00.000Z",
    }));

    releaseRoots();
    await Promise.all([rootsUpdate, heartbeatUpdate]);

    const settings = await loadHostDiskSettings(dataDir, "user-1");
    expect(settings.roots).toEqual(["/tmp/b"]);
    expect(settings.clientSeenAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("still denies access when enabled without granted roots", async () => {
    const dataDir = await tempDir();
    const settings = await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: [],
      clientSeenAt: new Date().toISOString(),
    });
    expect(hostDiskAccessAllowed(settings)).toBe(false);
  });

  it("still denies access when roots exist without a fresh client heartbeat", async () => {
    const dataDir = await tempDir();
    const settings = await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: ["/tmp/granted"],
      clientSeenAt: null,
    });
    expect(hostDiskAccessAllowed(settings)).toBe(false);
  });

  it("unavailable provider never reports availability", async () => {
    const provider = new UnavailableHostDiskProvider();
    expect(await provider.isAvailable("user-1")).toBe(false);
    await expect(provider.listFiles("user-1", "/", adapterContext())).rejects.toThrow(
      /unavailable/i,
    );
  });
});

describe("local host disk containment", () => {
  it("reads and writes only inside explicitly granted roots", async () => {
    const dataDir = await tempDir();
    const grant = path.join(dataDir, "Documents-granted");
    const outside = path.join(dataDir, "Desktop-not-granted");
    await mkdir(grant, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(grant, "notes.txt"), "hello from host\n", "utf8");
    await writeFile(path.join(outside, "secret.txt"), "nope\n", "utf8");

    await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: [grant],
      clientSeenAt: new Date().toISOString(),
    });

    const provider = new LocalHostDiskProvider({
      dataDir,
      ignoreClientHeartbeat: true,
    });
    expect(await provider.isAvailable("user-1")).toBe(true);

    const listed = await provider.listFiles("user-1", grant, adapterContext());
    expect(listed.map((entry) => path.basename(entry.path))).toContain("notes.txt");

    const bytes = await provider.readFile(
      "user-1",
      path.join(grant, "notes.txt"),
      adapterContext(),
    );
    expect(new TextDecoder().decode(bytes)).toBe("hello from host\n");

    await provider.writeFile(
      "user-1",
      {
        path: path.join(grant, "out.txt"),
        content: new TextEncoder().encode("written\n"),
      },
      adapterContext(),
    );
    expect(await readFile(path.join(grant, "out.txt"), "utf8")).toBe("written\n");

    await expect(
      provider.readFile("user-1", path.join(outside, "secret.txt"), adapterContext()),
    ).rejects.toThrow(/outside the granted folders/i);

    await expect(
      provider.writeFile(
        "user-1",
        {
          path: path.join(outside, "escape.txt"),
          content: new TextEncoder().encode("nope"),
        },
        adapterContext(),
      ),
    ).rejects.toThrow(/outside the granted folders/i);
  });

  it("does not treat Documents or Desktop as granted without opt-in roots", async () => {
    const dataDir = await tempDir();
    const documents = path.join(dataDir, "Documents");
    await mkdir(documents, { recursive: true });
    await writeFile(path.join(documents, "tax.txt"), "private\n", "utf8");

    const provider = new LocalHostDiskProvider({
      dataDir,
      ignoreClientHeartbeat: true,
      loadSettings: async () => ({
        enabled: false,
        roots: [],
        clientSeenAt: null,
      }),
    });
    expect(await provider.isAvailable("user-1")).toBe(false);
    await expect(
      provider.readFile("user-1", path.join(documents, "tax.txt"), adapterContext()),
    ).rejects.toThrow(/Host disk access is off/i);
  });
});

describe("host disk symlink containment", () => {
  it("rejects reads and writes that follow a symlink outside granted roots", async () => {
    const dataDir = await tempDir();
    const grant = path.join(dataDir, "granted");
    const outside = path.join(dataDir, "outside");
    await mkdir(grant, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "private\n", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(grant, "leak.txt"));

    await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: [grant],
      clientSeenAt: new Date().toISOString(),
    });

    const provider = new LocalHostDiskProvider({
      dataDir,
      ignoreClientHeartbeat: true,
    });

    await expect(
      provider.readFile("user-1", path.join(grant, "leak.txt"), adapterContext()),
    ).rejects.toThrow(/outside the granted folders/i);

    await expect(
      provider.writeFile(
        "user-1",
        {
          path: path.join(grant, "leak.txt"),
          content: new TextEncoder().encode("overwrite"),
        },
        adapterContext(),
      ),
    ).rejects.toThrow(/outside the granted folders/i);

    const listed = await provider.listFiles("user-1", grant, adapterContext());
    expect(listed.map((entry) => path.basename(entry.path))).not.toContain("leak.txt");
  });

  it("rejects reads through a directory symlink that leaves the grant", async () => {
    const dataDir = await tempDir();
    const grant = path.join(dataDir, "granted");
    const outside = path.join(dataDir, "outside");
    await mkdir(grant, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "private\n", "utf8");
    await symlink(outside, path.join(grant, "sub"));

    await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: [grant],
      clientSeenAt: new Date().toISOString(),
    });

    const provider = new LocalHostDiskProvider({
      dataDir,
      ignoreClientHeartbeat: true,
    });

    await expect(
      provider.readFile("user-1", path.join(grant, "sub", "secret.txt"), adapterContext()),
    ).rejects.toThrow(/outside the granted folders/i);

    await expect(
      provider.writeFile(
        "user-1",
        {
          path: path.join(grant, "sub", "planted.txt"),
          content: new TextEncoder().encode("nope"),
        },
        adapterContext(),
      ),
    ).rejects.toThrow(/outside the granted folders/i);
  });

  it("pins the opened inode so a check-then-use directory swap cannot escape", async () => {
    // After resolveInsideHostRoots, open uses O_NOFOLLOW and re-checks
    // realpath(/proc/self/fd/N). Swapping a nested dir to an outside symlink
    // between resolve and open must not yield an outside fd.
    const dataDir = await tempDir();
    const grant = path.join(dataDir, "granted");
    const outside = path.join(dataDir, "outside");
    const nested = path.join(grant, "nested");
    await mkdir(nested, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(nested, "file.txt"), "inside\n", "utf8");
    await writeFile(path.join(outside, "file.txt"), "outside-secret\n", "utf8");

    const target = path.join(nested, "file.txt");
    const swapNestedToOutside = async () => {
      await rm(nested, { recursive: true, force: true });
      await symlink(outside, nested);
    };

    await expect(
      readFileInsideHostRoots(target, [grant], { afterResolve: swapNestedToOutside }),
    ).rejects.toThrow(/outside the granted folders|ENOENT|ELOOP|EPERM|EACCES|ENOTDIR/i);

    // Recreate the inside tree for list/write races.
    await rm(nested, { recursive: true, force: true });
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "file.txt"), "inside\n", "utf8");

    await expect(
      listInsideHostRoots(nested, [grant], { afterResolve: swapNestedToOutside }),
    ).rejects.toThrow(/outside the granted folders|ENOENT|ELOOP|EPERM|EACCES|ENOTDIR/i);

    await rm(nested, { recursive: true, force: true });
    await mkdir(nested, { recursive: true });

    await expect(
      writeFileInsideHostRoots(path.join(nested, "planted.txt"), [grant], "x", {
        afterResolve: swapNestedToOutside,
      }),
    ).rejects.toThrow(/outside the granted folders|ENOENT|ELOOP|EPERM|EACCES|ENOTDIR/i);

    await rm(nested, { recursive: true, force: true });
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "file.txt"), "inside\n", "utf8");

    await expect(
      openInsideHostRoots(target, [grant], constants.O_RDONLY, {
        afterResolve: swapNestedToOutside,
      }),
    ).rejects.toThrow(/outside the granted folders|ENOENT|ELOOP|EPERM|EACCES|ENOTDIR/i);
  });

  it("keeps writes inside the pinned parent when the path is swapped to an outside symlink", async () => {
    // After the parent directory fd is pinned, replacing that directory entry
    // with an outside symlink must not redirect the rename/write.
    const dataDir = await tempDir();
    const grant = path.join(dataDir, "granted");
    const outside = path.join(dataDir, "outside");
    const nested = path.join(grant, "nested");
    await mkdir(nested, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "planted.txt"), "outside-secret\n", "utf8");

    const nestedBackup = path.join(grant, "nested-original");
    await expect(
      writeFileInsideHostRoots(path.join(nested, "planted.txt"), [grant], "inside-write\n", {
        afterParentPinned: async () => {
          await rename(nested, nestedBackup);
          await symlink(outside, nested);
        },
      }),
    ).resolves.toBeUndefined();

    // Outside content must be untouched; the write stayed on the pinned inode.
    expect(await readFile(path.join(outside, "planted.txt"), "utf8")).toBe("outside-secret\n");
    expect(await readFile(path.join(nestedBackup, "planted.txt"), "utf8")).toBe("inside-write\n");
  });

  it("keeps a write when the pinned parent is renamed inside the grant", async () => {
    // Renaming the destination parent within the grant must not false-reject or
    // unlink the committed file via a stale parentFdReal dirname check.
    const dataDir = await tempDir();
    const grant = path.join(dataDir, "granted");
    const nested = path.join(grant, "nested");
    await mkdir(nested, { recursive: true });

    const nestedMoved = path.join(grant, "nested-moved");
    await expect(
      writeFileInsideHostRoots(path.join(nested, "kept.txt"), [grant], "kept\n", {
        afterParentPinned: async () => {
          await rename(nested, nestedMoved);
        },
      }),
    ).resolves.toBeUndefined();

    expect(await readFile(path.join(nestedMoved, "kept.txt"), "utf8")).toBe("kept\n");
  });

  it("does not let recursive mkdir follow a swapped outside symlink", async () => {
    const dataDir = await tempDir();
    const grant = path.join(dataDir, "granted");
    const outside = path.join(dataDir, "outside");
    await mkdir(grant, { recursive: true });
    await mkdir(outside, { recursive: true });

    // Create nested/a as a real dir, then swap nested to an outside symlink after
    // resolve and before directory creation walks components.
    const nested = path.join(grant, "nested");
    await mkdir(nested, { recursive: true });
    const target = path.join(nested, "deep", "file.txt");

    await expect(
      writeFileInsideHostRoots(target, [grant], "x", {
        afterResolve: async () => {
          await rm(nested, { recursive: true, force: true });
          await symlink(outside, nested);
        },
      }),
    ).rejects.toThrow(/outside the granted folders|ENOENT|ELOOP|EPERM|EACCES|ENOTDIR/i);

    // Outside must not gain new directories from the failed write.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("host disk exclusive claims", () => {
  it("lets only one claim win for the same pending operation", async () => {
    const dataDir = await tempDir();
    const { BridgingHostDiskProvider, claimHostDiskOperation } = await import(
      "./bridge-host-disk.js"
    );
    const provider = new BridgingHostDiskProvider({
      dataDir,
      timeoutMs: 1000,
      pollIntervalMs: 20,
    });
    await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: [path.join(dataDir, "granted")],
      clientSeenAt: new Date().toISOString(),
    });
    await mkdir(path.join(dataDir, "granted"), { recursive: true });

    // Enqueue one list operation through the private queue by calling listFiles with a short abort.
    const controller = new AbortController();
    const listing = provider.listFiles("user-1", "", {
      ...adapterContext(),
      signal: controller.signal,
    });

    let first: Awaited<ReturnType<typeof claimHostDiskOperation>> = null;
    for (let attempt = 0; attempt < 50 && !first; attempt += 1) {
      first = await claimHostDiskOperation(dataDir, "user-1");
      if (!first) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(first?.status).toBe("claimed");

    const second = await claimHostDiskOperation(dataDir, "user-1");
    expect(second).toBeNull();

    controller.abort();
    await expect(listing).rejects.toThrow();
  });

  it("lets only one of timeout and client completion win", async () => {
    const dataDir = await tempDir();
    const { BridgingHostDiskProvider, claimHostDiskOperation, completeHostDiskOperation } =
      await import("./bridge-host-disk.js");
    const provider = new BridgingHostDiskProvider({
      dataDir,
      timeoutMs: 5_000,
      pollIntervalMs: 20,
    });
    await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: [path.join(dataDir, "granted")],
      clientSeenAt: new Date().toISOString(),
    });
    await mkdir(path.join(dataDir, "granted"), { recursive: true });

    const controller = new AbortController();
    const listing = provider.listFiles("user-1", "", {
      ...adapterContext(),
      signal: controller.signal,
    });

    let claimed: Awaited<ReturnType<typeof claimHostDiskOperation>> = null;
    for (let attempt = 0; attempt < 50 && !claimed; attempt += 1) {
      claimed = await claimHostDiskOperation(dataDir, "user-1");
      if (!claimed) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(claimed?.status).toBe("claimed");
    if (!claimed) throw new Error("expected claim");

    // Direct race: timeout error vs client done. Only one exclusive rename to a
    // terminal .done.json / .error.json may succeed.
    const results = await Promise.allSettled([
      completeHostDiskOperation(dataDir, "user-1", {
        id: claimed.id,
        status: "error",
        error: "Timed out waiting for the Mac or phone app to handle host disk access",
      }),
      completeHostDiskOperation(dataDir, "user-1", {
        id: claimed.id,
        status: "done",
        entries: [],
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const { readdir, readFile: readOp } = await import("node:fs/promises");
    const dir = path.join(dataDir, "host-disk", "operations", "user-1");
    const names = await readdir(dir);
    const terminals = names.filter(
      (name) => name === `${claimed.id}.done.json` || name === `${claimed.id}.error.json`,
    );
    expect(terminals).toHaveLength(1);
    expect(names.some((name) => name === `${claimed.id}.claimed.json`)).toBe(false);

    const raw = await readOp(path.join(dir, terminals[0]!), "utf8");
    const op = JSON.parse(raw) as { status: string };
    expect(["done", "error"]).toContain(op.status);
    expect(op.status).toBe(terminals[0]!.endsWith(".done.json") ? "done" : "error");

    controller.abort();
    await expect(listing).rejects.toThrow();
  });

  it("honors client done published after completingHoldMs while completing still held", async () => {
    const dataDir = await tempDir();
    const { BridgingHostDiskProvider, claimHostDiskOperation } = await import(
      "./bridge-host-disk.js"
    );

    const provider = new BridgingHostDiskProvider({
      dataDir,
      timeoutMs: 40,
      pollIntervalMs: 10,
      completionGraceMs: 30,
      // Soft hold is short; sliding must still honor a publish past this bound.
      completingHoldMs: 60,
    });
    await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: [path.join(dataDir, "granted")],
      clientSeenAt: new Date().toISOString(),
    });
    await mkdir(path.join(dataDir, "granted"), { recursive: true });

    const listing = provider.listFiles("user-1", "", adapterContext());

    let claimed: Awaited<ReturnType<typeof claimHostDiskOperation>> = null;
    for (let attempt = 0; attempt < 50 && !claimed; attempt += 1) {
      claimed = await claimHostDiskOperation(dataDir, "user-1");
      if (!claimed) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(claimed?.status).toBe("claimed");
    if (!claimed) throw new Error("expected claim");

    const { rename, readFile, writeFile } = await import("node:fs/promises");
    const claimedPath = path.join(
      dataDir,
      "host-disk",
      "operations",
      "user-1",
      `${claimed.id}.claimed.json`,
    );
    const completingPath = path.join(
      dataDir,
      "host-disk",
      "operations",
      "user-1",
      `${claimed.id}.completing.json`,
    );
    await rename(claimedPath, completingPath);

    const clientDone = (async () => {
      // Past fixed completingHoldMs (60) after grace start; within timeout ceiling.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const raw = JSON.parse(await readFile(completingPath, "utf8")) as Record<string, unknown>;
      const donePath = path.join(
        dataDir,
        "host-disk",
        "operations",
        "user-1",
        `${claimed.id}.done.json`,
      );
      await writeFile(
        completingPath,
        `${JSON.stringify({ ...raw, status: "done", entries: [] }, null, 2)}\n`,
        "utf8",
      );
      await rename(completingPath, donePath);
    })();

    await expect(listing).resolves.toEqual([]);
    await clientDone;
  });

  it("honors client done published after completionGrace while completing held", async () => {
    const dataDir = await tempDir();
    const { BridgingHostDiskProvider, claimHostDiskOperation } = await import(
      "./bridge-host-disk.js"
    );

    const provider = new BridgingHostDiskProvider({
      dataDir,
      timeoutMs: 40,
      pollIntervalMs: 10,
      completionGraceMs: 50,
      completingHoldMs: 800,
    });
    await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: [path.join(dataDir, "granted")],
      clientSeenAt: new Date().toISOString(),
    });
    await mkdir(path.join(dataDir, "granted"), { recursive: true });

    const listing = provider.listFiles("user-1", "", adapterContext());

    let claimed: Awaited<ReturnType<typeof claimHostDiskOperation>> = null;
    for (let attempt = 0; attempt < 50 && !claimed; attempt += 1) {
      claimed = await claimHostDiskOperation(dataDir, "user-1");
      if (!claimed) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(claimed?.status).toBe("claimed");
    if (!claimed) throw new Error("expected claim");

    // Exclusive .completing.json held past the fixed grace deadline; publish later.
    const { rename, readFile, writeFile } = await import("node:fs/promises");
    const claimedPath = path.join(
      dataDir,
      "host-disk",
      "operations",
      "user-1",
      `${claimed.id}.claimed.json`,
    );
    const completingPath = path.join(
      dataDir,
      "host-disk",
      "operations",
      "user-1",
      `${claimed.id}.completing.json`,
    );
    await rename(claimedPath, completingPath);

    const clientDone = (async () => {
      // After main timeout (~40ms) + grace (50ms); still within completingHoldMs.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const raw = JSON.parse(await readFile(completingPath, "utf8")) as Record<string, unknown>;
      const donePath = path.join(
        dataDir,
        "host-disk",
        "operations",
        "user-1",
        `${claimed.id}.done.json`,
      );
      await writeFile(
        completingPath,
        `${JSON.stringify({ ...raw, status: "done", entries: [] }, null, 2)}\n`,
        "utf8",
      );
      await rename(completingPath, donePath);
    })();

    await expect(listing).resolves.toEqual([]);
    await clientDone;
  });

  it("honors client done published while timeout only saw claimed", async () => {
    const dataDir = await tempDir();
    const { BridgingHostDiskProvider, claimHostDiskOperation } = await import(
      "./bridge-host-disk.js"
    );

    const provider = new BridgingHostDiskProvider({
      dataDir,
      timeoutMs: 40,
      pollIntervalMs: 10,
      completionGraceMs: 30,
      completingHoldMs: 800,
      completingMaxMs: 5_000,
    });
    await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: [path.join(dataDir, "granted")],
      clientSeenAt: new Date().toISOString(),
    });
    await mkdir(path.join(dataDir, "granted"), { recursive: true });

    const listing = provider.listFiles("user-1", "", adapterContext());

    let claimed: Awaited<ReturnType<typeof claimHostDiskOperation>> = null;
    for (let attempt = 0; attempt < 50 && !claimed; attempt += 1) {
      claimed = await claimHostDiskOperation(dataDir, "user-1");
      if (!claimed) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(claimed?.status).toBe("claimed");
    if (!claimed) throw new Error("expected claim");

    // Keep exclusive .claimed.json through server timeout; publish .done later.
    // Timeout must not steal the live claim and reject the late success.
    const { rename, readFile, writeFile } = await import("node:fs/promises");
    const claimedPath = path.join(
      dataDir,
      "host-disk",
      "operations",
      "user-1",
      `${claimed.id}.claimed.json`,
    );

    const clientDone = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const raw = JSON.parse(await readFile(claimedPath, "utf8")) as Record<string, unknown>;
      const completingPath = path.join(
        dataDir,
        "host-disk",
        "operations",
        "user-1",
        `${claimed.id}.completing.json`,
      );
      const donePath = path.join(
        dataDir,
        "host-disk",
        "operations",
        "user-1",
        `${claimed.id}.done.json`,
      );
      await rename(claimedPath, completingPath);
      await writeFile(
        completingPath,
        `${JSON.stringify({ ...raw, status: "done", entries: [] }, null, 2)}\n`,
        "utf8",
      );
      await rename(completingPath, donePath);
    })();

    await expect(listing).resolves.toEqual([]);
    await clientDone;
  });

  it("honors client done published while timeout only saw completing", async () => {
    const dataDir = await tempDir();
    const { BridgingHostDiskProvider, claimHostDiskOperation } = await import(
      "./bridge-host-disk.js"
    );

    const provider = new BridgingHostDiskProvider({
      dataDir,
      timeoutMs: 40,
      pollIntervalMs: 10,
      completionGraceMs: 800,
    });
    await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: [path.join(dataDir, "granted")],
      clientSeenAt: new Date().toISOString(),
    });
    await mkdir(path.join(dataDir, "granted"), { recursive: true });

    const listing = provider.listFiles("user-1", "", adapterContext());

    let claimed: Awaited<ReturnType<typeof claimHostDiskOperation>> = null;
    for (let attempt = 0; attempt < 50 && !claimed; attempt += 1) {
      claimed = await claimHostDiskOperation(dataDir, "user-1");
      if (!claimed) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(claimed?.status).toBe("claimed");
    if (!claimed) throw new Error("expected claim");

    // Client already holds the exclusive .completing.json take when the server
    // times out; publish .done.json during the post-timeout grace window.
    const { rename, readFile, writeFile } = await import("node:fs/promises");
    const claimedPath = path.join(
      dataDir,
      "host-disk",
      "operations",
      "user-1",
      `${claimed.id}.claimed.json`,
    );
    const completingPath = path.join(
      dataDir,
      "host-disk",
      "operations",
      "user-1",
      `${claimed.id}.completing.json`,
    );
    await rename(claimedPath, completingPath);

    const clientDone = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const raw = JSON.parse(await readFile(completingPath, "utf8")) as Record<string, unknown>;
      const donePath = path.join(
        dataDir,
        "host-disk",
        "operations",
        "user-1",
        `${claimed.id}.done.json`,
      );
      await writeFile(
        completingPath,
        `${JSON.stringify({ ...raw, status: "done", entries: [] }, null, 2)}\n`,
        "utf8",
      );
      await rename(completingPath, donePath);
    })();

    await expect(listing).resolves.toEqual([]);
    await clientDone;
  });

  it("does not delete .completing.json when it briefly holds status done", async () => {
    const dataDir = await tempDir();
    const { BridgingHostDiskProvider, claimHostDiskOperation } = await import(
      "./bridge-host-disk.js"
    );

    const provider = new BridgingHostDiskProvider({
      dataDir,
      timeoutMs: 30,
      pollIntervalMs: 5,
      completionGraceMs: 500,
    });
    await saveHostDiskSettings(dataDir, "user-1", {
      enabled: true,
      roots: [path.join(dataDir, "granted")],
      clientSeenAt: new Date().toISOString(),
    });
    await mkdir(path.join(dataDir, "granted"), { recursive: true });

    const listing = provider.listFiles("user-1", "", adapterContext());

    let claimed: Awaited<ReturnType<typeof claimHostDiskOperation>> = null;
    for (let attempt = 0; attempt < 50 && !claimed; attempt += 1) {
      claimed = await claimHostDiskOperation(dataDir, "user-1");
      if (!claimed) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(claimed?.status).toBe("claimed");
    if (!claimed) throw new Error("expected claim");

    const {
      access,
      constants: fsConstants,
      rename,
      readFile,
      writeFile,
    } = await import("node:fs/promises");
    const claimedPath = path.join(
      dataDir,
      "host-disk",
      "operations",
      "user-1",
      `${claimed.id}.claimed.json`,
    );
    const completingPath = path.join(
      dataDir,
      "host-disk",
      "operations",
      "user-1",
      `${claimed.id}.completing.json`,
    );
    const donePath = path.join(
      dataDir,
      "host-disk",
      "operations",
      "user-1",
      `${claimed.id}.done.json`,
    );
    await rename(claimedPath, completingPath);
    const raw = JSON.parse(await readFile(completingPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      completingPath,
      `${JSON.stringify({ ...raw, status: "done", entries: [] }, null, 2)}\n`,
      "utf8",
    );

    // Give the waiter time to observe completing-with-done without treating it
    // as a terminal artifact (and without unlinking it).
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(access(completingPath, fsConstants.F_OK)).resolves.toBeUndefined();

    await rename(completingPath, donePath);
    await expect(listing).resolves.toEqual([]);
  });
});

describe("host disk posix *at pinning", () => {
  it("does not join child names under /dev/fd paths", async () => {
    const { readFile } = await import("node:fs/promises");
    const pathSource = await readFile(new URL("./host-disk-path.ts", import.meta.url), "utf8");
    const ipcSource = await readFile(
      new URL("../../../apps/desktop/src/host-disk-ipc.ts", import.meta.url),
      "utf8",
    );
    expect(pathSource).not.toMatch(/path\.join\(\s*fdDirPath\(/);
    expect(pathSource).not.toMatch(/readdir\(\s*fdDirPath\(/);
    expect(pathSource).not.toMatch(/readdir\(\s*fdReal\s*\)/);
    expect(pathSource).not.toMatch(/readdir\(\s*fdRefPath\(/);
    expect(pathSource).toMatch(/readdirNamesAt\(/);
    expect(pathSource).toMatch(/openatChild\(/);
    expect(pathSource).toMatch(/mkdiratChild\(/);
    expect(pathSource).toMatch(/renameatChild\(/);
    expect(ipcSource).not.toMatch(/readdir\(\s*fdReal\s*\)/);
    expect(ipcSource).not.toMatch(/readdir\(\s*fdRefPath\(/);
    expect(ipcSource).toMatch(/readdirNamesAt\(/);
    // Write publish: re-bind parent via grant walk + matching (dev,ino), sync
    // last-mile gate, then renameat; on residual escape roll back / unlink only
    // our inode — never unlink dest by basename alone.
    expect(ipcSource).toMatch(/const pinnedParent = await parentHandle\.stat\(\)/);
    expect(ipcSource).toMatch(/openInsideGrants\(parentPath, dirFlags\)/);
    expect(ipcSource).toMatch(/assertFdStillInsideRoots\(publishHandle\.fd, realRoots\)/);
    expect(ipcSource).toMatch(/renameatChild\(publishHandle\.fd, tempName, baseName\)/);
    expect(ipcSource).not.toMatch(/unlinkatChild\(parentHandle\.fd, baseName\)/);
    expect(ipcSource).toMatch(/unlinkIfOwnedChild\(publishHandle\.fd, baseName, publishedStat\)/);
    expect(ipcSource).toMatch(/unlinkIfOwnedChild\(/);
    // Owned unlink renames to an unguessable name before unlinkat to avoid
    // deleting a replacement that raced into the basename after fstat.
    expect(ipcSource).toMatch(/\.rakazo-unlink-/);
    expect(ipcSource).toMatch(/renameatChild\(dirFd, name, trash\)/);
    expect(ipcSource).toMatch(/unlinkOwnedChildAnywhere\(/);
    expect(ipcSource).toMatch(/readdirNamesAt\(/);
    expect(ipcSource).toMatch(/tempOwned/);
    // Identity opens use O_NONBLOCK so a FIFO in a grant cannot hang cleanup.
    expect(ipcSource).toMatch(/O_NONBLOCK/);
    expect(ipcSource).toMatch(/IDENTITY_OPEN/);
    expect(pathSource).toMatch(/O_NONBLOCK/);
    expect(pathSource).toMatch(/IDENTITY_OPEN/);
    expect(pathSource).toMatch(/AT_REMOVEDIR/);
    expect(pathSource).toMatch(/unlinkOwnedEscapedDir\(/);
    expect(pathSource).toMatch(/createdSegment/);
    expect(pathSource).toMatch(/assertFdStillInsideRoots\(/);
    expect(pathSource).toMatch(/Do not rename trash back onto/);
    expect(pathSource).toMatch(/pathFromOpenFd\(tempHandle\.fd\)/);
    // mkdir: async assert + sync gate immediately before mkdirat; owned AT_REMOVEDIR.
    expect(ipcSource).toMatch(/assertFdStillInsideRoots\(parentHandle\.fd, realRoots\)/);
    expect(ipcSource).toMatch(
      /assertFdStillInsideRoots\(parentHandle\.fd, realRoots\);\s*\n\s*try \{\s*\n\s*mkdiratChild/m,
    );
    expect(ipcSource).toMatch(/AT_REMOVEDIR/);
    expect(ipcSource).toMatch(/unlinkOwnedEscapedDir\(/);
    expect(ipcSource).toMatch(/unlinkOwnedEscapedFile\(/);
    expect(ipcSource).toMatch(/Do not rename trash back onto/);
    expect(ipcSource).toMatch(/emptyDirAt\(/);
    expect(ipcSource).toMatch(/unlinkOwnedEscapedDir\(parentHandle\.fd, owned, segment, next\)/);
    // Darwin AT_REMOVEDIR is 0x80; Linux is 0x200 — a Linux-only constant
    // breaks macOS mkdir rollback and can leave grant-escaping directories.
    expect(ipcSource).toMatch(
      /const AT_REMOVEDIR = process\.platform === ["']darwin["'] \? 0x80 : 0x200/,
    );
    expect(pathSource).not.toMatch(/unlinkatChild\(parentHandle\.fd, baseName\)/);
    expect(pathSource).toMatch(/unlinkIfOwnedChild\(/);
    expect(pathSource).toMatch(/\.rakazo-unlink-/);
    expect(pathSource).toMatch(/renameatChild\(dirFd, name, trash\)/);
  });

  it("openat/mkdirat/renameat keep writes on the pinned directory inode", async () => {
    const { posixAtAvailable, openatChild, mkdiratChild, renameatChild, unlinkatChild } =
      await import("./host-disk-posix-at.js");
    expect(posixAtAvailable()).toBe(true);

    const dataDir = await tempDir();
    const parent = path.join(dataDir, "parent");
    await mkdir(parent, { recursive: true });
    const { open } = await import("node:fs/promises");
    const dirFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);
    const parentHandle = await open(parent, dirFlags);
    try {
      mkdiratChild(parentHandle.fd, "child");
      const temp = openatChild(
        parentHandle.fd,
        "x.tmp",
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        await temp.writeFile("pinned\n");
      } finally {
        await temp.close();
      }
      renameatChild(parentHandle.fd, "x.tmp", "x.txt");
      expect(await readFile(path.join(parent, "x.txt"), "utf8")).toBe("pinned\n");
      unlinkatChild(parentHandle.fd, "x.txt");
    } finally {
      await parentHandle.close();
    }
  });

  it("cleanup skips replacements under the same basename", async () => {
    const { posixAtAvailable, openatChild, unlinkatChild } = await import(
      "./host-disk-posix-at.js"
    );
    expect(posixAtAvailable()).toBe(true);

    const dataDir = await tempDir();
    const parent = path.join(dataDir, "parent");
    await mkdir(parent, { recursive: true });
    const { open, writeFile, readFile, unlink } = await import("node:fs/promises");
    const dirFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);
    const parentHandle = await open(parent, dirFlags);
    try {
      const ownedHandle = openatChild(
        parentHandle.fd,
        "race.txt",
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_TRUNC |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      let owned: { dev: unknown; ino: unknown };
      try {
        await ownedHandle.writeFile("owned\n");
        owned = await ownedHandle.stat();
      } finally {
        await ownedHandle.close();
      }

      // Swap in a replacement under the same basename (unlink first so create
      // is a distinct dirent; inode numbers may still recycle).
      await unlink(path.join(parent, "race.txt"));
      await writeFile(path.join(parent, "race.txt"), "replacement\n", "utf8");

      const check = openatChild(
        parentHandle.fd,
        "race.txt",
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const st = await check.stat();
        // Mimic unlinkIfOwnedChild with a *stale* ownership record that no
        // longer matches the live dirent — must not delete the replacement.
        const staleOwned = { dev: owned.dev, ino: `not-${String(owned.ino)}` };
        if (
          String(st.dev) === String(staleOwned.dev) &&
          String(st.ino) === String(staleOwned.ino)
        ) {
          unlinkatChild(parentHandle.fd, "race.txt");
        }
      } finally {
        await check.close();
      }

      expect(await readFile(path.join(parent, "race.txt"), "utf8")).toBe("replacement\n");

      // Matching ownership still removes our own inode.
      const victim = openatChild(
        parentHandle.fd,
        "victim.txt",
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_TRUNC |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      let victimOwned: { dev: unknown; ino: unknown };
      try {
        await victim.writeFile("victim\n");
        victimOwned = await victim.stat();
      } finally {
        await victim.close();
      }
      const victimCheck = openatChild(
        parentHandle.fd,
        "victim.txt",
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const st = await victimCheck.stat();
        if (
          String(st.dev) === String(victimOwned.dev) &&
          String(st.ino) === String(victimOwned.ino)
        ) {
          unlinkatChild(parentHandle.fd, "victim.txt");
        }
      } finally {
        await victimCheck.close();
      }
      await expect(readFile(path.join(parent, "victim.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await parentHandle.close();
    }
  });

  it("pathFromOpenFd returns the open inode path (not /dev/fd)", async () => {
    const { open } = await import("node:fs/promises");
    const { pathFromOpenFd } = await import("./host-disk-posix-at.js");
    const dataDir = await tempDir();
    const target = path.join(dataDir, "file.txt");
    await writeFile(target, "hi\n", "utf8");
    const handle = await open(target, constants.O_RDONLY);
    try {
      const fromFd = pathFromOpenFd(handle.fd);
      expect(fromFd).toBe(await realpath(target));
      expect(fromFd).not.toMatch(/\/dev\/fd\//);
      expect(fromFd).not.toMatch(/\/proc\/self\/fd\//);
    } finally {
      await handle.close();
    }
  });

  it("realpathOfFd matches pathFromOpenFd after canonicalize", async () => {
    const { open } = await import("node:fs/promises");
    const { pathFromOpenFd } = await import("./host-disk-posix-at.js");
    const { realpathOfFd } = await import("./host-disk-path.js");
    const dataDir = await tempDir();
    const dir = path.join(dataDir, "dir");
    await mkdir(dir, { recursive: true });
    const handle = await open(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      expect(await realpathOfFd(handle.fd)).toBe(await realpath(pathFromOpenFd(handle.fd)));
    } finally {
      await handle.close();
    }
  });

  it("list enumerates the pinned dirfd after a pathname→symlink swap", async () => {
    const { readdirNamesAt, posixAtAvailable } = await import("./host-disk-posix-at.js");
    expect(posixAtAvailable()).toBe(true);

    const dataDir = await tempDir();
    const grant = path.join(dataDir, "granted");
    const outside = path.join(dataDir, "outside");
    const nested = path.join(grant, "nested");
    await mkdir(nested, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(nested, "inside-only.txt"), "in\n", "utf8");
    await writeFile(path.join(outside, "secret-outside.txt"), "secret\n", "utf8");

    const nestedBackup = path.join(grant, "nested-original");
    const listed = await listInsideHostRoots(nested, [grant], {
      afterDirPinned: async () => {
        await rename(nested, nestedBackup);
        await symlink(outside, nested);
      },
    });

    const names = listed.map((entry) => path.basename(entry.path));
    expect(names).toContain("inside-only.txt");
    expect(names).not.toContain("secret-outside.txt");
    // Pathname readdir of the swapped path would disclose the outside name.
    expect(await readdir(nested)).toContain("secret-outside.txt");
    // Holding the backup inode fd still lists only the pinned directory.
    const { open } = await import("node:fs/promises");
    const pinned = await open(nestedBackup, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      expect(readdirNamesAt(pinned.fd)).toEqual(expect.arrayContaining(["inside-only.txt"]));
      expect(readdirNamesAt(pinned.fd)).not.toContain("secret-outside.txt");
    } finally {
      await pinned.close();
    }
  });

  it("readdirNamesAt handles short and long variable-length dirent names", async () => {
    const { readdirNamesAt, posixAtAvailable } = await import("./host-disk-posix-at.js");
    expect(posixAtAvailable()).toBe(true);

    const dataDir = await tempDir();
    const dir = path.join(dataDir, "entries");
    await mkdir(dir, { recursive: true });
    const shortName = "a";
    const longName = `${"n".repeat(200)}.txt`;
    // NAME_MAX (255) — Linux d_reclen pads to 280; must not reject as out of range.
    const maxName = `${"m".repeat(251)}.txt`;
    expect(maxName.length).toBe(255);
    await writeFile(path.join(dir, shortName), "s\n", "utf8");
    await writeFile(path.join(dir, longName), "l\n", "utf8");
    await writeFile(path.join(dir, maxName), "m\n", "utf8");

    const { open } = await import("node:fs/promises");
    const handle = await open(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      const names = readdirNamesAt(handle.fd);
      expect(names).toEqual(expect.arrayContaining([shortName, longName, maxName]));
    } finally {
      await handle.close();
    }
  });

  it("list/write still work without /dev/fd child traversal", async () => {
    const dataDir = await tempDir();
    const grant = path.join(dataDir, "granted");
    await mkdir(grant, { recursive: true });
    await writeFile(path.join(grant, "a.txt"), "hello\n", "utf8");

    const listed = await listInsideHostRoots(grant, [grant]);
    expect(listed.map((entry) => path.basename(entry.path))).toContain("a.txt");

    await writeFileInsideHostRoots(path.join(grant, "b.txt"), [grant], "world\n");
    expect(await readFile(path.join(grant, "b.txt"), "utf8")).toBe("world\n");
  });
});
