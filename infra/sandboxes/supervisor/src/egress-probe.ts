import { randomBytes } from "node:crypto";
import { isIPv4 } from "node:net";
import type Docker from "dockerode";
import { attestRestrictedEgress } from "./egress-attest.js";

/**
 * Restricted egress is enforced by host firewall rules the supervisor cannot see
 * (infra/compose/restrict-computer-egress.sh); without them a restricted computer
 * network is as open as any other. Before a restricted computer starts, a
 * throwaway container on a `rakazo-c*` bridge tries TCP to that bridge's gateway,
 * which is the Docker host. The ruleset's INPUT drop makes every attempt time out;
 * a refused or accepted connection means the host answered, so the rules are missing.
 * The forwarded path is also checked directly
 * against the cloud metadata endpoint: where one exists it accepts connections unless
 * the drop is in place, and elsewhere nothing answers, so only a connection fails.
 * Explicit computer DNS is forwarded from the computer's network, where the ruleset drops
 * private resolvers, so at least one configured IPv4 server must answer a query from the
 * bridge (which has no IPv6). Any reply counts, so a resolver that only knows internal
 * names still passes.
 *
 * Forwarded destination drops cannot be verified behaviorally — blocked address space
 * usually has nothing listening, so a removed DROP rule looks identical to an enforced
 * one. After the behavioral checks, the firewall itself is therefore read back and every
 * required rule attested (see egress-attest.ts); anything short of a full match fails
 * closed, so a partially removed ruleset never passes as verified.
 */
export const EGRESS_PROBE_NETWORK = "rakazo-egress-probe";
// 22 is open or allowed on most servers, 1 is closed nearly everywhere: either one
// answering is enough to show the host takes connections from computer bridges.
const PROBE_PORTS = [22, 1];
const PROBE_SECONDS_PER_PORT = 2;
const PROBE_DEADLINE_MS = 60_000;
const HOST_REACHABLE = 3;
const METADATA_ADDRESS = "169.254.169.254";
const METADATA_REACHABLE = 4;
const DNS_UNREACHABLE = 5;
// Each server gets two short tries, so one lost packet does not fail a start (18s for three).
const DNS_SECONDS = 3;

export const EGRESS_NOT_ENFORCED =
  "SANDBOX_COMPUTER_EGRESS=restricted is not enforced on this Docker host: run infra/compose/restrict-computer-egress.sh on the host (see docs/self-host-docker-computers.md)";

/**
 * A completed probe that shows the rules are missing, as opposed to a probe that could not finish
 * (a Docker error, an unexpected exit, the deadline). Only this one lets `auto` fall back to open.
 */
export class EgressNotEnforced extends Error {
  constructor(reason: string) {
    super(`${EGRESS_NOT_ENFORCED} (${reason})`);
  }
}

/**
 * Shell run in the probe container; exits 0 only when every gateway port timed out
 * and the metadata endpoint did not accept a connection, and some IPv4 `dns` server replied.
 */
export function egressProbeScript(gateway: string, dns: string[] = []) {
  const attempts = PROBE_PORTS.map(
    (port) =>
      `timeout ${PROBE_SECONDS_PER_PORT} bash -c 'exec 3<>/dev/tcp/${gateway}/${port}' 2>/dev/null; [ $? -eq 124 ] || exit ${HOST_REACHABLE}`,
  );
  const metadata = `timeout ${PROBE_SECONDS_PER_PORT} bash -c 'exec 3<>/dev/tcp/${METADATA_ADDRESS}/80' 2>/dev/null && exit ${METADATA_REACHABLE}`;
  // An A query for example.com with ID "RK"; a reply echoes the ID.
  // Docker's embedded resolver forwards to at most the first three servers.
  const queries = dns
    .slice(0, 3)
    .filter((server) => isIPv4(server))
    .map(
      (server) =>
        `for _ in 1 2; do timeout ${DNS_SECONDS} bash -c 'exec 3<>/dev/udp/$0/53 && printf "RK\\1\\0\\0\\1\\0\\0\\0\\0\\0\\0\\7example\\3com\\0\\0\\1\\0\\1" >&3 && [ "$(head -c2 <&3)" = RK ]' ${server} 2>/dev/null && exit 0; done`,
    );
  const last = queries.length > 0 ? `exit ${DNS_UNREACHABLE}` : "exit 0";
  return [...attempts, metadata, ...queries, last].join("\n");
}

export type EgressProbeVerdict =
  | "enforced"
  | "host-reachable"
  | "metadata-reachable"
  | "dns-unreachable"
  | "inconclusive";

export function egressProbeVerdict(statusCode: number | undefined): EgressProbeVerdict {
  if (statusCode === 0) return "enforced";
  if (statusCode === HOST_REACHABLE) return "host-reachable";
  if (statusCode === METADATA_REACHABLE) return "metadata-reachable";
  if (statusCode === DNS_UNREACHABLE) return "dns-unreachable";
  return "inconclusive";
}

/** Throws unless host and metadata traffic is blocked and any configured DNS server answers. */
export async function verifyRestrictedEgress(
  docker: Docker,
  image: string,
  dns: string[] | undefined,
  ensureAttestImage: () => Promise<string>,
) {
  const suffix = randomBytes(4).toString("hex").slice(0, 7);
  const name = `${EGRESS_PROBE_NETWORK}-${suffix}`;
  const bridge = `rakazo-c${suffix}`;
  await docker.createNetwork({
    Name: name,
    Driver: "bridge",
    CheckDuplicate: true,
    Labels: { "rakazo.egressProbe": "true" },
    Options: { "com.docker.network.bridge.name": bridge },
  });
  const network = docker.getNetwork(name);
  let container: Docker.Container | undefined;
  try {
    const info = await network.inspect();
    if (info.Options?.["com.docker.network.bridge.name"] !== bridge) {
      throw new Error("cannot verify restricted egress: probe network lacks the named bridge");
    }
    const gateway = info.IPAM?.Config?.find((entry) => entry.Gateway?.includes("."))?.Gateway;
    if (!gateway)
      throw new Error("cannot verify restricted egress: probe network has no IPv4 gateway");
    container = await docker.createContainer({
      Image: image,
      Entrypoint: ["bash", "-c", egressProbeScript(gateway, dns)],
      Cmd: [],
      Labels: { "rakazo.egressProbe": "true" },
      HostConfig: {
        NetworkMode: name,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
        Memory: 64 * 1024 * 1024,
        PidsLimit: 32,
      },
    });
    await container.start();
    const result = await Promise.race([
      container.wait() as Promise<{ StatusCode?: number }>,
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), PROBE_DEADLINE_MS).unref(),
      ),
    ]);
    const verdict = egressProbeVerdict(result?.StatusCode);
    if (verdict === "host-reachable") {
      throw new EgressNotEnforced("a computer bridge reached the host");
    }
    if (verdict === "metadata-reachable") {
      throw new EgressNotEnforced("a computer bridge reached the metadata endpoint");
    }
    // The DNS list is validated only now, after the rules are known to be in
    // place: `auto` on a host without the ruleset must still fall back to open
    // egress instead of failing every start on a DNS misconfiguration.
    // Restricted computer networks are IPv4-only, so an IPv6 resolver could never
    // be queried; skipping it silently would make the check pass without testing.
    if (dns?.some((server) => !isIPv4(server))) {
      throw new Error(
        "SANDBOX_COMPUTER_DNS must list IPv4 servers: restricted computer networks are IPv4-only (see docs/self-host-docker-computers.md)",
      );
    }
    // Docker's embedded resolver and resolv.conf use at most three servers; a
    // longer list would be silently truncated, so refuse it rather than check
    // only a prefix.
    if (dns && dns.length > 3) {
      throw new Error(
        "SANDBOX_COMPUTER_DNS lists more than three servers; at most three are used (see docs/self-host-docker-computers.md)",
      );
    }
    if (verdict === "dns-unreachable") {
      throw new Error(
        "No SANDBOX_COMPUTER_DNS server answered from a restricted computer network; set servers reachable from there, such as public resolvers (see docs/self-host-docker-computers.md)",
      );
    }
    if (verdict === "inconclusive") {
      // The probe could not finish, so the rules are neither shown missing nor
      // verified: say that, not the install remediation, and let `auto` retry
      // instead of falling back to open on a guess.
      throw new Error(
        `could not verify restricted egress: the probe exited ${result?.StatusCode ?? "late"}; see the supervisor log`,
      );
    }
    // Behavioral checks passed; now attest the live firewall itself, so a
    // partially removed ruleset cannot pass as verified. The attestation runs
    // the supervisor-built probe image, never the configurable computer image.
    await attestRestrictedEgress(docker, await ensureAttestImage());
  } finally {
    await container?.remove({ force: true }).catch(() => undefined);
    await network.remove().catch(() => undefined);
  }
}

// A crashed supervisor can leave its probe network or container behind, and every
// network holds a subnet from the engine's address pools, which run out after a few
// dozen. Remove probe leftovers older than any probe can run: an active probe from a
// concurrent supervisor is younger than the probe deadlines, so it is never touched,
// and two supervisors racing on the same leftover both succeed (one remove wins, the
// other's failure is ignored).
const ABANDONED_PROBE_AGE_MS = 10 * 60_000;

export async function cleanupAbandonedProbeNetworks(docker: Docker) {
  const cutoff = Date.now() - ABANDONED_PROBE_AGE_MS;
  // Containers first: a leftover probe container keeps its network in use, and a
  // probe stuck far past its deadline is crashed by definition.
  const containers = await docker
    .listContainers({ all: true, filters: { label: ["rakazo.egressProbe=true"] } })
    .catch(() => undefined);
  for (const { Id, Created, Labels } of containers ?? []) {
    if (!Id || Labels?.["rakazo.egressProbe"] !== "true") continue;
    if ((Created ?? 0) * 1000 > cutoff) continue;
    await docker
      .getContainer(Id)
      .remove({ force: true })
      .catch(() => undefined);
  }
  const networks = await docker
    .listNetworks({ filters: { label: ["rakazo.egressProbe=true"] } })
    .catch(() => undefined);
  for (const { Name } of networks ?? []) {
    if (!Name?.startsWith(EGRESS_PROBE_NETWORK)) continue;
    const info = await docker
      .getNetwork(Name)
      .inspect()
      .catch(() => undefined);
    if (!info || Object.keys(info.Containers ?? {}).length > 0) continue;
    const created = Date.parse(info.Created ?? "");
    if (!Number.isFinite(created) || created > cutoff) continue;
    await docker
      .getNetwork(Name)
      .remove()
      .catch(() => undefined);
  }
}
