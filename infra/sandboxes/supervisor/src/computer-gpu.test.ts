import type * as NodeFs from "node:fs";
import type { Stats } from "node:fs";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerGpuMatches, resolveComputerGpu } from "./computer-gpu.js";
import { containerCreateOptions } from "./computer-spec.js";

describe("computer render node", () => {
  // A stat result as lstat returns it for a device numbered major:minor.
  const device = (major: number, minor: number, gid = 105) =>
    ({
      isSymbolicLink: () => false,
      isCharacterDevice: () => true,
      rdev: major * 256 + minor,
      gid,
    }) as unknown as Stats;

  it("parses the computer render node, with none when unset", () => {
    const unreadable = (): Stats => {
      throw new Error("ENOENT");
    };
    expect(resolveComputerGpu(undefined, unreadable)).toBeUndefined();
    expect(resolveComputerGpu(" ", unreadable)).toBeUndefined();
    // The group is the node's own.
    expect(resolveComputerGpu(" /dev/dri/renderD129 ", () => device(226, 129, 993))).toEqual({
      node: "/dev/dri/renderD129",
      gid: 993,
    });
    // A supervisor that cannot see the node fails closed, also in a container without the bind.
    expect(() => resolveComputerGpu("/dev/dri/renderD128", unreadable)).toThrow(
      /the supervisor cannot see it; give the supervisor \/dev\/dri:\/dev\/dri:ro/,
    );
    for (const value of [
      "/dev/dri/card0",
      "/dev/dri",
      "/dev/dri/renderD128/../card0",
      "/dev/kvm",
      "renderD128",
      // The group comes from the node; a gid written next to it is not taken.
      "/dev/dri/renderD128:993",
      "/dev/dri/renderD128,/dev/dri/renderD129",
    ])
      expect(() => resolveComputerGpu(value, () => device(226, 128))).toThrow(
        /SANDBOX_COMPUTER_GPU/,
      );
  });

  it("refuses a render node name that is not the render node itself", () => {
    const temp = mkdtempSync(path.join(tmpdir(), "rakazo-render-node-"));
    // The names stay /dev/dri/renderD*; only what they are on disk changes.
    const real = (node: string) => lstatSync(path.join(temp, path.basename(node)));
    try {
      symlinkSync("/dev/null", path.join(temp, "renderD128"));
      mkdirSync(path.join(temp, "renderD129"));
      writeFileSync(path.join(temp, "renderD130"), "");
      expect(() => resolveComputerGpu("/dev/dri/renderD128", real)).toThrow(/is a symlink/);
      for (const value of ["/dev/dri/renderD129", "/dev/dri/renderD130"])
        expect(() => resolveComputerGpu(value, real)).toThrow(/is not a character device/);
      // /dev/null is a character device, but not DRM's.
      expect(() => resolveComputerGpu("/dev/dri/renderD131", () => lstatSync("/dev/null"))).toThrow(
        /is device 1:3, not a DRM render node/,
      );
      // card0 and controlD64 are DRM display nodes: same major, minors below 128.
      for (const minor of [0, 1, 64, 127])
        expect(() => resolveComputerGpu("/dev/dri/renderD128", () => device(226, minor))).toThrow(
          new RegExp(`is device 226:${minor}, not a DRM render node`),
        );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("passes the render node and its group into computers only when configured", () => {
    const base = {
      name: "rakazo-bot-x",
      image: "img",
      botId: "x",
      spaceId: "s",
      homePath: "/data/x",
    };
    const plain = containerCreateOptions(base).HostConfig;
    expect(plain).not.toHaveProperty("Devices");
    expect(plain).not.toHaveProperty("GroupAdd");
    const gpu = containerCreateOptions({
      ...base,
      gpu: { node: "/dev/dri/renderD128", gid: 993 },
    }).HostConfig;
    expect(gpu).toMatchObject({
      Devices: [
        {
          PathOnHost: "/dev/dri/renderD128",
          PathInContainer: "/dev/dri/renderD128",
          CgroupPermissions: "rw",
        },
      ],
      GroupAdd: ["993"],
    });
    // The rest of the confinement stays as it is without a GPU.
    expect(gpu).toMatchObject({ CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"] });
    expect(gpu).not.toHaveProperty("Privileged");
  });

  it("matches a computer's render node to the configured one", () => {
    const gpu = { node: "/dev/dri/renderD128", gid: 993 };
    const created = (want?: typeof gpu) =>
      containerCreateOptions({
        name: "rakazo-bot-x",
        image: "img",
        botId: "x",
        spaceId: "s",
        homePath: "/data/x",
        ...(want ? { gpu: want } : {}),
      }) as unknown as Parameters<typeof computerGpuMatches>[0];
    expect(computerGpuMatches({ HostConfig: {} } as never, undefined)).toBe(true);
    expect(computerGpuMatches(created(), undefined)).toBe(true);
    expect(computerGpuMatches(created(gpu), gpu)).toBe(true);
    // Turning the setting on or off, or moving it to another node or group, replaces the computer.
    expect(computerGpuMatches(created(), gpu)).toBe(false);
    expect(computerGpuMatches(created(gpu), undefined)).toBe(false);
    expect(computerGpuMatches(created({ ...gpu, node: "/dev/dri/renderD129" }), gpu)).toBe(false);
    expect(computerGpuMatches(created({ ...gpu, gid: 44 }), gpu)).toBe(false);
    // A node passed in read-only leaves the browser without the GPU, so that computer is replaced too.
    const readOnly = created(gpu) as unknown as {
      HostConfig: { Devices: { CgroupPermissions: string }[] };
    };
    readOnly.HostConfig.Devices[0]!.CgroupPermissions = "r";
    expect(computerGpuMatches(readOnly as never, gpu)).toBe(false);
  });
});

describe("supervisor startup with SANDBOX_COMPUTER_GPU", () => {
  const node = "/dev/dri/renderD128";
  // lstat as the host answers it for `node`: a character device numbered major:minor.
  const mockRenderNode = async (major: number, minor: number) => {
    const actual = await vi.importActual<typeof NodeFs>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actual,
      lstatSync: ((target: string, ...rest: unknown[]) =>
        target === node
          ? ({
              isSymbolicLink: () => false,
              isCharacterDevice: () => true,
              rdev: major * 256 + minor,
              gid: 993,
            } as unknown as Stats)
          : (actual.lstatSync as (...args: unknown[]) => unknown)(
              target,
              ...rest,
            )) as typeof actual.lstatSync,
    }));
  };

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("starts with a valid render node and passes it with its group into computers", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_GPU", node);
    await mockRenderNode(226, 128);
    vi.resetModules();
    // The route module reads the setting at import, as the supervisor does when it starts.
    await expect(import("./routes.js")).resolves.toHaveProperty("supervisorApp");
    const { computerGpu } = await import("./context.js");
    expect(computerGpu).toEqual({ node, gid: 993 });
    const { containerCreateOptions: create } = await import("./computer-spec.js");
    expect(
      create({
        name: "rakazo-bot-x",
        image: "img",
        botId: "x",
        spaceId: "s",
        homePath: "/data/x",
        gpu: computerGpu,
      }).HostConfig,
    ).toMatchObject({
      Devices: [{ PathOnHost: node, PathInContainer: node, CgroupPermissions: "rw" }],
      GroupAdd: ["993"],
    });
  });

  it("refuses to start with a node that is not a render node", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_GPU", node);
    await mockRenderNode(226, 0);
    vi.resetModules();
    await expect(import("./routes.js")).rejects.toThrow(
      /Unsupported SANDBOX_COMPUTER_GPU .*not a DRM render node/,
    );
  });
});
