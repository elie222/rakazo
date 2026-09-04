import { createHash } from "node:crypto";

export const COMPUTER_IMAGE = process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local";
export const COMPUTER_UID = 1000;
export const COMPUTER_GID = 1000;
export const COMPUTER_USER = `${COMPUTER_UID}:${COMPUTER_GID}`;
export const TEAM_SCREEN_LIMIT = 8;
export const COMPUTER_CONTROL_PORT = 7070;
export const SCREEN_HOST = process.env.SANDBOX_SCREEN_HOST ?? "127.0.0.1";
export type ScreenNetworkMode = "published" | "internal" | "isolated";

/**
 * Resource ceilings for a bot computer.
 *
 * A computer runs Xvfb, a window manager and a full Chromium on behalf of an
 * agent that decides for itself what to open. #343 gave these containers a
 * pids ceiling, but Memory and NanoCpus are still unset, so one runaway page is
 * a host-wide memory and CPU event that takes every other bot and the Rakazo
 * services down with it. Every service in docker-compose.prod.yml already
 * carries mem_limit; this applies the same discipline to the containers that
 * actually run untrusted page content.
 *
 * Defaults are generous enough for real browsing and small enough that a single
 * computer cannot exhaust the 8 GB host docs/self-host.md documents for the
 * Docker computer topology. The pids default is #343's existing 2048, unchanged.
 * Set any of these to "0", "none" or "unlimited" to opt out.
 */
const DEFAULT_COMPUTER_MEMORY = "2g";
const DEFAULT_COMPUTER_CPUS = "2";
const DEFAULT_COMPUTER_PIDS_LIMIT = "2048";
/** The daemon refuses HostConfig.Memory below this at container creation. */
const MIN_DOCKER_MEMORY_BYTES = 6 * 1024 ** 2;

const MEMORY_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
};

function isUnlimited(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === "0" || value === "unlimited" || value === "none";
}

/** Bytes from a docker-style size string ("2g", "1536m", "1073741824"). */
export function parseMemoryBytes(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const match = /^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`${name} must be a size like "2g", "1536m" or a byte count, received "${raw}"`);
  }
  const scale = MEMORY_UNITS[(match[2] ?? "b").toLowerCase()] ?? 1;
  const bytes = Math.floor(Number(match[1]) * scale);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${name} must resolve to a positive byte count, received "${raw}"`);
  }
  // The daemon rejects a limit under 6 MiB at container creation. Catching it here turns a
  // per-bot 500 at the first `POST /computers` into a startup failure that names the variable.
  if (bytes < MIN_DOCKER_MEMORY_BYTES) {
    throw new Error(`${name} must be at least 6m, Docker's minimum, received "${raw}"`);
  }
  return bytes;
}

/** Docker NanoCpus (1e9 per core) from a CPU count like "1.5". */
export function parseNanoCpus(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const value = Number(raw.trim());
  // A positive value below 1e-9 floors to 0 nanocpus, which Docker reads as *unlimited*. Checking
  // the converted number, not just the input, keeps a cap from silently becoming no cap.
  const nanoCpus = Math.floor(value * 1e9);
  if (!Number.isFinite(value) || value <= 0 || nanoCpus <= 0) {
    throw new Error(`${name} must be a positive number of CPUs, received "${raw}"`);
  }
  return nanoCpus;
}

function parsePidsLimit(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

/** The host resource ceilings applied to every bot computer. */
export function computerResourceLimits() {
  const memoryBytes = parseMemoryBytes(
    "RAKAZO_COMPUTER_MEMORY",
    process.env.RAKAZO_COMPUTER_MEMORY ?? DEFAULT_COMPUTER_MEMORY,
  );
  const nanoCpus = parseNanoCpus(
    "RAKAZO_COMPUTER_CPUS",
    process.env.RAKAZO_COMPUTER_CPUS ?? DEFAULT_COMPUTER_CPUS,
  );
  const pidsLimit = parsePidsLimit(
    "RAKAZO_COMPUTER_PIDS_LIMIT",
    process.env.RAKAZO_COMPUTER_PIDS_LIMIT ?? DEFAULT_COMPUTER_PIDS_LIMIT,
  );
  return {
    // Memory and MemorySwap are set together: leaving MemorySwap unset lets the
    // container swap to twice Memory, so the ceiling would not hold.
    Memory: memoryBytes,
    MemorySwap: memoryBytes,
    NanoCpus: nanoCpus,
    PidsLimit: pidsLimit,
  };
}

export function resolveScreenNetworkMode(value: string | undefined): ScreenNetworkMode {
  if (!value || value === "published") return "published";
  if (value === "internal" || value === "isolated") return value;
  throw new Error(`Unsupported SANDBOX_SCREEN_NETWORK value: ${value}`);
}

export function hostComputerUser(uid = process.getuid?.(), gid = process.getgid?.()): string {
  if (uid === undefined || gid === undefined || uid === 0) return COMPUTER_USER;
  return `${uid}:${gid}`;
}

export function screenPorts(index: number) {
  if (index < 0 || index >= TEAM_SCREEN_LIMIT) {
    throw new Error(
      `screen index ${index} exceeds the Team Computer limit of ${TEAM_SCREEN_LIMIT}`,
    );
  }
  return {
    display: `:${index + 1}`,
    displayNumber: index + 1,
    viewPort: String(6080 + index * 2),
    controlPort: String(6081 + index * 2),
    viewVncPort: 5900 + index * 2,
    controlVncPort: 5901 + index * 2,
  };
}

export function computerPortBindings(publishControlPort = false) {
  const ExposedPorts: Record<string, object> = {};
  const PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (let index = 0; index < TEAM_SCREEN_LIMIT; index += 1) {
    const ports = screenPorts(index);
    ExposedPorts[`${ports.viewPort}/tcp`] = {};
    ExposedPorts[`${ports.controlPort}/tcp`] = {};
    PortBindings[`${ports.viewPort}/tcp`] = [{ HostIp: "127.0.0.1", HostPort: "0" }];
    PortBindings[`${ports.controlPort}/tcp`] = [{ HostIp: "127.0.0.1", HostPort: "0" }];
  }
  // Host-run Docker Desktop supervisors need an opt-in loopback mapping.
  // Otherwise control stays unpublished on the container network.
  if (publishControlPort) {
    ExposedPorts[`${COMPUTER_CONTROL_PORT}/tcp`] = {};
    PortBindings[`${COMPUTER_CONTROL_PORT}/tcp`] = [{ HostIp: "127.0.0.1", HostPort: "0" }];
  }
  return { ExposedPorts, PortBindings };
}

export interface ComputerCreateInput {
  name: string;
  image: string;
  botId: string;
  spaceId: string;
  homePath: string;
  user?: string;
  controlToken?: string;
  networkMode?: string;
  publishControlPort?: boolean;
}

interface PointerInput {
  kind: "pointer";
  x: number;
  y: number;
  button?: "left" | "right";
  type: "move" | "down" | "up" | "click";
}

export type SandboxInput =
  | { kind: "key"; key: string; modifiers?: string[] }
  | PointerInput
  | { kind: "clipboard"; text: string };

export function containerCreateOptions(input: ComputerCreateInput) {
  const ports = computerPortBindings(input.publishControlPort);
  return {
    Image: input.image,
    name: input.name,
    User: input.user ?? COMPUTER_USER,
    Tty: true,
    Env: [
      "DISPLAY=:1",
      "HOME=/home/rakazo",
      "PATH=/home/rakazo/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NPM_CONFIG_PREFIX=/home/rakazo/.local",
      "PIP_USER=1",
      ...(input.controlToken ? [`RAKAZO_COMPUTER_CONTROL_TOKEN=${input.controlToken}`] : []),
    ],
    Labels: {
      "rakazo.managed": "true",
      "rakazo.botId": input.botId,
      "rakazo.spaceId": input.spaceId,
    },
    ExposedPorts: ports.ExposedPorts,
    HostConfig: {
      Binds: [`${input.homePath}:/home/rakazo`],
      PortBindings: ports.PortBindings,
      ShmSize: 256 * 1024 * 1024,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ...computerResourceLimits(),
      ReadonlyPaths: ["/usr/share/novnc"],
      AutoRemove: false,
      NetworkMode: input.networkMode ?? "bridge",
    },
    WorkingDir: "/home/rakazo",
  };
}

export function sanitizeIdentifier(botId: string) {
  const safe = botId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40);
  return safe || "box";
}

export function containerNameFor(botId: string) {
  return `rakazo-bot-${sanitizeIdentifier(botId)}`;
}

export function computerNetworkNameFor(botId: string) {
  // Keep distinct botIds on distinct networks even when sanitization collapses
  // characters (e.g. "a/b" and "ab"). Do not change containerNameFor — that
  // name must stay stable so an existing computer can resume.
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 32);
  return `rakazo-computer-${sanitizeIdentifier(botId).slice(0, 32)}-${hash}`;
}

/** Current and prior network names used by this PR, for delete cleanup. */
export function computerNetworkNamesForCleanup(botId: string) {
  const safe = sanitizeIdentifier(botId);
  const digest = createHash("sha256").update(botId).digest("hex");
  return [
    computerNetworkNameFor(botId),
    `rakazo-computer-${safe}`,
    `rakazo-computer-${safe.slice(0, 32)}-${digest.slice(0, 8)}`,
  ];
}

/**
 * Legacy unsalted network names can collide across botIds. Only remove such a
 * network when no other bot's container is still attached.
 */
export function legacyNetworkOwnedSolelyBy(
  botId: string,
  attachedBotIds: Array<string | undefined>,
): boolean {
  return attachedBotIds.every((owner) => owner === botId);
}

export function screenUrlFor(hostPort: string, host = SCREEN_HOST) {
  return `http://${host}:${hostPort}/embed.html`;
}

/**
 * Decide which host:port clients (and readiness probes) should use.
 *
 * Per-bot NetworkMode isolation must not change this: a container always has a
 * docker-internal IP on its network, but browsers cannot load that 172.x
 * address. Compose modes that attach the supervisor/screen proxy to the bot
 * network may return the container IP; host-run supervisors use the published
 * loopback mapping.
 */
export function resolveScreenPublishTarget(input: {
  screenNetwork: ScreenNetworkMode;
  networkMode: string | null | undefined;
  networks: Record<string, { IPAddress?: string } | undefined> | null | undefined;
  hostPort: string | undefined;
  containerPort: string;
  screenHost?: string;
}): { host: string; port: string } | undefined {
  if (input.screenNetwork === "internal" || input.screenNetwork === "isolated") {
    const address = input.networkMode ? input.networks?.[input.networkMode]?.IPAddress : undefined;
    if (address) return { host: address, port: input.containerPort };
    return undefined;
  }
  if (input.hostPort) return { host: input.screenHost ?? SCREEN_HOST, port: input.hostPort };
  return undefined;
}

type ControlPortBindings =
  | Record<string, Array<{ HostIp?: string; HostPort?: string }> | null | undefined>
  | null
  | undefined;

function validHostPort(port: string | undefined): port is string {
  return !!port && /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535;
}

/** Resolve an assigned runtime port only when every control binding is loopback. */
export function publishedLoopbackControlHostPort(portBindings: ControlPortBindings) {
  const bindings = portBindings?.[`${COMPUTER_CONTROL_PORT}/tcp`];
  if (!bindings?.length || bindings.some((binding) => binding.HostIp !== "127.0.0.1")) {
    return undefined;
  }
  return bindings.find((binding) => validHostPort(binding.HostPort))?.HostPort;
}

/**
 * Reuse only containers whose configured control publication matches the setting.
 * Inspect HostConfig so stopped containers and Docker's automatic port allocation
 * (empty or zero HostPort) work before a runtime port has been assigned.
 */
export function controlPortPublicationMatches(
  portBindings: ControlPortBindings,
  publishControlPort: boolean,
): boolean {
  const bindings = portBindings?.[`${COMPUTER_CONTROL_PORT}/tcp`];
  if (!publishControlPort) return !bindings?.length;
  return (
    !!bindings?.length &&
    bindings.every(
      (binding) =>
        binding.HostIp === "127.0.0.1" &&
        (binding.HostPort === "" || binding.HostPort === "0" || validHostPort(binding.HostPort)),
    )
  );
}

/**
 * Resolve the computer control service. Prefer a published loopback HostPort
 * when provided; otherwise use the Docker network IP. When requirePublishedHostPort
 * is set, never fall back to the container IP (unreachable from Docker Desktop hosts).
 */
export function resolveComputerControlEndpoint(input: {
  token: string | undefined;
  networkMode: string | null | undefined;
  networks: Record<string, { IPAddress?: string } | undefined> | null | undefined;
  publishedHostPort?: string;
  requirePublishedHostPort?: boolean;
}): { url: string; token: string } | undefined {
  if (!input.token) return undefined;
  if (validHostPort(input.publishedHostPort)) {
    return {
      url: `http://127.0.0.1:${input.publishedHostPort}/v1/desktop`,
      token: input.token,
    };
  }
  if (input.requirePublishedHostPort) return undefined;
  const address =
    (input.networkMode ? input.networks?.[input.networkMode]?.IPAddress : undefined) ||
    Object.values(input.networks ?? {}).find((network) => network?.IPAddress)?.IPAddress;
  if (!address) return undefined;
  return { url: `http://${address}:${COMPUTER_CONTROL_PORT}/v1/desktop`, token: input.token };
}

export function xdotoolCommand(input: SandboxInput): string[] {
  if (input.kind === "key") {
    const key = mapKey(input.key);
    const mods = (input.modifiers ?? []).map(mapKey);
    const combo = [...mods, key].join("+");
    return ["xdotool", "key", "--clearmodifiers", combo];
  }
  if (input.kind === "pointer") {
    const btn = input.button === "right" ? "3" : "1";
    if (input.type === "move")
      return ["xdotool", "mousemove", "--", String(input.x), String(input.y)];
    if (input.type === "down") {
      return ["xdotool", "mousemove", "--", String(input.x), String(input.y), "mousedown", btn];
    }
    if (input.type === "up") return ["xdotool", "mouseup", btn];
    return ["xdotool", "mousemove", "--", String(input.x), String(input.y), "click", btn];
  }
  return ["xdotool", "type", "--clearmodifiers", "--", input.text];
}

function mapKey(key: string) {
  const lower = key.toLowerCase();
  if (lower === "enter" || lower === "return") return "Return";
  if (lower === "esc" || lower === "escape") return "Escape";
  if (lower === "space") return "space";
  if (lower === "tab") return "Tab";
  if (lower === "backspace") return "BackSpace";
  if (lower === "ctrl" || lower === "control") return "ctrl";
  if (lower === "alt") return "alt";
  if (lower === "shift") return "shift";
  if (lower === "meta" || lower === "cmd" || lower === "super") return "super";
  return key;
}
