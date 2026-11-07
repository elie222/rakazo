import type { Stats } from "node:fs";
import { lstatSync } from "node:fs";
import type Docker from "dockerode";

/** A host GPU render node passed into every computer (SANDBOX_COMPUTER_GPU). */
export interface ComputerGpu {
  /** `/dev/dri/renderD<N>`, at the same path inside the computer. */
  node: string;
  /** Group that owns the node on the host; the computer user joins it to open the node. */
  gid: number;
}

const RENDER_NODE = /^\/dev\/dri\/renderD\d+$/;
/** DRM's character device major; render nodes take minors from 128, below are display nodes. */
const DRM_MAJOR = 226;
const DRM_RENDER_MINOR = 128;

/** Why a device is not a DRM render node, or undefined when it is one. */
export function renderNodeProblem(device: {
  symlink: boolean;
  characterDevice: boolean;
  major: number;
  minor: number;
}) {
  if (device.symlink) return "is a symlink; name the render node itself";
  if (!device.characterDevice) return "is not a character device";
  if (device.major !== DRM_MAJOR || device.minor < DRM_RENDER_MINOR)
    return `is device ${device.major}:${device.minor}, not a DRM render node (${DRM_MAJOR}:${DRM_RENDER_MINOR} and up)`;
  return undefined;
}

// Linux's dev_t layout, as glibc's major() and minor() read it.
function hostDevice(stats: Stats) {
  return {
    symlink: stats.isSymbolicLink(),
    characterDevice: stats.isCharacterDevice(),
    major: Math.floor(stats.rdev / 256) & 0xfff,
    minor: (stats.rdev & 0xff) | (Math.floor(stats.rdev / 4096) & 0xfff00),
  };
}

/**
 * The render node from SANDBOX_COMPUTER_GPU, or none when unset, checked on the host object:
 * Docker follows a symlink to whatever device it names, so `renderD128 -> card0` would pass a
 * display node in by name alone. The supervisor must see the host's /dev/dri (a supervisor in
 * a container gets it as a read-only bind) and takes the group from the node itself. Root on
 * the host swapping the node between this check and Docker's start is out of scope: host root
 * owns the machine.
 */
export function resolveComputerGpu(
  value = process.env.SANDBOX_COMPUTER_GPU,
  inspect: (node: string) => Stats = lstatSync,
): ComputerGpu | undefined {
  const node = (value ?? "").trim();
  if (!node) return undefined;
  const fail = (reason: string) =>
    new Error(`Unsupported SANDBOX_COMPUTER_GPU "${node}": ${reason}`);
  if (!RENDER_NODE.test(node)) throw fail("expected /dev/dri/renderD<N>");
  let stats: Stats;
  try {
    stats = inspect(node);
  } catch {
    throw fail("the supervisor cannot see it; give the supervisor /dev/dri:/dev/dri:ro");
  }
  const problem = renderNodeProblem(hostDevice(stats));
  if (problem) throw fail(`${node} ${problem}`);
  return { node, gid: stats.gid };
}

/** The host config that passes the render node in; nothing without one. */
export function computerGpuHostConfig(gpu: ComputerGpu | undefined) {
  if (!gpu) return {};
  return {
    Devices: [{ PathOnHost: gpu.node, PathInContainer: gpu.node, CgroupPermissions: "rw" }],
    GroupAdd: [String(gpu.gid)],
  };
}

/** Whether a computer has exactly the configured render node; devices are fixed at creation. */
export function computerGpuMatches(
  info: Pick<Docker.ContainerInspectInfo, "HostConfig">,
  desired: ComputerGpu | undefined,
) {
  const devices = info.HostConfig.Devices ?? [];
  const groups = info.HostConfig.GroupAdd ?? [];
  if (!desired) return devices.length === 0 && groups.length === 0;
  return (
    devices.length === 1 &&
    devices[0]?.PathOnHost === desired.node &&
    devices[0]?.PathInContainer === desired.node &&
    groups.length === 1 &&
    groups[0] === String(desired.gid)
  );
}
