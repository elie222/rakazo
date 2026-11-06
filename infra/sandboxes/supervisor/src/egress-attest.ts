import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import type Docker from "dockerode";
import { followProgress } from "./computer-image.js";
import { EgressNotEnforced } from "./egress-probe.js";

/**
 * Behavioral probing from a restricted bridge cannot prove the forwarded
 * destination drops: the blocked address space usually has no responder, so a
 * removed DROP rule looks identical to an enforced one. The only trustworthy
 * evidence is the live firewall itself, so this module reads it: a short-lived
 * container in the host network namespace with CAP_NET_ADMIN dumps the Docker
 * host's iptables chains, and the required rules must be present, in order,
 * at the head of their chains — exactly what
 * infra/compose/restrict-computer-egress.sh installs and repairs.
 *
 * Anything short of that match fails closed: a missing binary, a missing chain,
 * a removed drop or a foreign rule inserted above the managed prefix all refuse
 * restricted egress. Rules genuinely missing lets `auto` fall back to open;
 * everything else fails the provision so the next one tries again.
 *
 * The probe runs with host-network CAP_NET_ADMIN, so its image is never the
 * configurable computer image: it is built by the supervisor itself, from this
 * repository's infra/sandboxes/egress-attest context, under an unqualified
 * name that is never pulled (see attestImageEnsurer).
 */

export const BRIDGE_PREFIX = "rakazo-c";

// Must match blocked_destinations_v4/v6 in infra/compose/restrict-computer-egress.sh;
// egress-attest.test.ts asserts the script's --print output against these lists.
export const REQUIRED_V4_DROPS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
];
export const REQUIRED_V6_DROPS = ["::1/128", "fc00::/7", "fe80::/10", "ff00::/8"];

const ATTEST_DEADLINE_MS = 30_000;

/** The image the attestation probe runs. Unqualified, so Docker never pulls it. */
export const ATTEST_IMAGE = "rakazo/egress-attest:local";

/**
 * Makes sure the attestation image exists, building it from the repository's
 * own context. Never pulled: an image reached through a registry is exactly the
 * trust this probe must not take. Like the computer image, a local name can be
 * spoofed by whoever already controls the Docker socket.
 */
export function attestImageEnsurer(docker: Docker, context: string) {
  let attempt: Promise<void> | undefined;
  return () => {
    attempt ??= provideAttestImage(docker, context).finally(() => {
      attempt = undefined;
    });
    return attempt;
  };
}

async function provideAttestImage(docker: Docker, context: string) {
  try {
    await docker.getImage(ATTEST_IMAGE).inspect();
    return;
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode !== 404) throw error;
  }
  try {
    await access(path.join(context, "Dockerfile"), constants.R_OK);
  } catch {
    throw new Error(`cannot attest restricted egress: ${ATTEST_IMAGE} is missing`);
  }
  await followProgress((abortSignal) =>
    docker.buildImage(
      { context, src: ["Dockerfile"] },
      { t: ATTEST_IMAGE, version: "2", abortSignal },
    ),
  );
  await docker.getImage(ATTEST_IMAGE).inspect();
}

/** Rules the iptables backend must hold, in chain order, per family. */
function requiredRules(family: "v4" | "v6") {
  const drops = family === "v4" ? REQUIRED_V4_DROPS : REQUIRED_V6_DROPS;
  return {
    input: [
      `in=${BRIDGE_PREFIX}+ out= ct=ESTABLISHED,RELATED jump=ACCEPT dest= extra=-m conntrack`,
      `in=${BRIDGE_PREFIX}+ out= ct= jump=DROP dest= extra=`,
    ],
    user: [
      `in=${BRIDGE_PREFIX}+ out=${BRIDGE_PREFIX}+ ct= jump=RETURN dest= extra=`,
      ...drops.map((cidr) => `in=${BRIDGE_PREFIX}+ out= ct= jump=DROP dest=${cidr} extra=`),
    ],
  };
}

// Canonical form mirroring the script's normalize_rule: the kernel may print
// -d ahead of -i and sort conntrack states, so compare fields, not tokens.
function normalizeRule(rule: string) {
  const tokens = rule.trim().split(/\s+/);
  let input = "";
  let output = "";
  let dest = "";
  let jump = "";
  let ct = "";
  const extra: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (
      token === "-i" ||
      token === "-o" ||
      token === "-d" ||
      token === "-j" ||
      token === "--ctstate"
    ) {
      const value = tokens[i + 1] ?? "";
      i += 1;
      if (token === "-i") input = value;
      else if (token === "-o") output = value;
      else if (token === "-d") dest = value;
      else if (token === "-j") jump = value;
      else ct = [...value.split(",")].sort().join(",");
    } else extra.push(token);
  }
  return `in=${input} out=${output} ct=${ct} jump=${jump} dest=${dest} extra=${extra.join(" ")}`;
}

function chainHasPrefix(rules: string[], wanted: string[], chain: string) {
  if (rules.length < wanted.length) {
    throw new EgressNotEnforced(`${chain} holds fewer managed rules than required`);
  }
  const normalized = rules.map(normalizeRule);
  if (wanted.some((rule) => !normalized.includes(rule))) {
    throw new EgressNotEnforced(`${chain} is missing managed rules`);
  }
  for (let i = 0; i < wanted.length; i += 1) {
    if (normalized[i] !== wanted[i]) {
      throw new Error(
        `cannot verify restricted egress: ${chain} rule ${i + 1} precedes the managed rule`,
      );
    }
  }
}

/** iptables -S output lines for one chain, without the leading -A CHAIN. */
function parseChain(output: string, chain: string) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`-A ${chain} `))
    .map((line) => line.slice(chain.length + 4));
}

function chainReadable(section: string | undefined) {
  return (
    section !== undefined &&
    !/^iptables v/i.test(section) &&
    !/iptables-failed|ip6tables-(?:absent|failed)|no chain|not found|permission denied/i.test(
      section,
    )
  );
}

/**
 * The managed drops live in DOCKER-USER, which only runs because Docker's own
 * FORWARD chain jumps to it first. An intact DOCKER-USER that nothing jumps to
 * enforces nothing: a missing jump means the rules are not attached (auto may
 * fall open), and a jump that is not FORWARD's first rule could be bypassed by
 * whatever sits above it, which we cannot verify.
 */
function verifyForwardJump(forwardRules: string[], family: "v4" | "v6") {
  const jumpIndex = forwardRules.findIndex(
    (rule) => normalizeRule(rule) === "in= out= ct= jump=DOCKER-USER dest= extra=",
  );
  if (jumpIndex === -1) {
    throw new EgressNotEnforced(
      `the ${family} FORWARD chain does not jump to DOCKER-USER, so the managed rules are not attached`,
    );
  }
  if (jumpIndex !== 0) {
    throw new Error(
      `cannot verify restricted egress: the ${family} FORWARD chain filters traffic before DOCKER-USER`,
    );
  }
}

function verifyIptablesFamily(
  sections: Record<string, string>,
  family: "v4" | "v6",
  required: boolean,
) {
  const key = family === "v4" ? "V4" : "V6";
  const user = sections[`${key}USER`];
  const input = sections[`${key}INPUT`];
  const forward = sections[`${key}FORWARD`];
  if (!chainReadable(user) || !chainReadable(input) || !chainReadable(forward)) {
    // An unreadable chain does not prove enforcement is absent. In particular,
    // a failed ip6tables command is not evidence that IPv6 rules are missing.
    throw new Error(
      `could not read ${family} iptables rules from the host network namespace (${user ?? input ?? forward ?? "no output"})`,
    );
  }
  if (!required) return;
  const wanted = requiredRules(family);
  chainHasPrefix(parseChain(user ?? "", "DOCKER-USER"), wanted.user, "DOCKER-USER");
  chainHasPrefix(parseChain(input ?? "", "INPUT"), wanted.input, "INPUT");
  verifyForwardJump(parseChain(forward ?? "", "FORWARD"), family);
}

export function parseAttestation(output: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = "";
  for (const line of output.split("\n")) {
    const match = /^==RAKAZO-(\w+)==$/.exec(line.trim());
    if (match) {
      current = match[1] ?? "";
      sections[current] = "";
    } else if (current) {
      sections[current] = sections[current] ? `${sections[current]}\n${line}` : line;
    }
  }
  return sections;
}

export function verifyAttestation(output: string) {
  const sections = parseAttestation(output);
  if (sections.DONE === undefined) {
    throw new Error("the attestation probe produced no output");
  }
  verifyIptablesFamily(sections, "v4", true);
  if (sections.IFINET6 === undefined || sections.IFINET6.includes("ifinet6-unreadable")) {
    throw new Error("could not read host IPv6 state");
  }
  // /proc/net/if_inet6 lists scope as the 4th column; 00 is global.
  const ipv6Lines = sections.IFINET6.split("\n").filter((line) => line.trim());
  if (
    ipv6Lines.some(
      (line) =>
        !/^[0-9a-f]{32}\s+[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]{2}\s+[0-9a-f]+\s+\S+$/i.test(
          line.trim(),
        ),
    )
  ) {
    throw new Error("could not parse host IPv6 state");
  }
  sections.GLOBALIPV6 = ipv6Lines.some((line) => line.trim().split(/\s+/)[3] === "00") ? "yes" : "";
  // Mirror the install script: the IPv6 family is only skipped when the host
  // has no global IPv6; otherwise it must verify like IPv4.
  if (sections.GLOBALIPV6) verifyIptablesFamily(sections, "v6", true);
}

const ATTEST_SCRIPT = [
  "echo ==RAKAZO-V4USER==",
  "iptables -w 2 -S DOCKER-USER 2>&1 || echo iptables-failed",
  "echo ==RAKAZO-V4INPUT==",
  "iptables -w 2 -S INPUT 2>&1 || echo iptables-failed",
  "echo ==RAKAZO-V4FORWARD==",
  "iptables -w 2 -S FORWARD 2>&1 || echo iptables-failed",
  "echo ==RAKAZO-V6USER==",
  "ip6tables -w 2 -S DOCKER-USER 2>&1 || echo ip6tables-failed",
  "echo ==RAKAZO-V6INPUT==",
  "ip6tables -w 2 -S INPUT 2>&1 || echo ip6tables-failed",
  "echo ==RAKAZO-V6FORWARD==",
  "ip6tables -w 2 -S FORWARD 2>&1 || echo ip6tables-failed",
  "echo ==RAKAZO-IFINET6==",
  "cat /proc/net/if_inet6 2>/dev/null || echo ifinet6-unreadable",
  "echo ==RAKAZO-DONE==",
].join("\n");

/**
 * Reads the host's live firewall through a throwaway host-network container and
 * throws unless every required rule is in place. `EgressNotEnforced` means the
 * rules are provably missing; any other error means they could not be verified.
 */
export async function attestRestrictedEgress(docker: Docker, image: string) {
  let container: Docker.Container | undefined;
  try {
    container = await docker.createContainer({
      Image: image,
      Entrypoint: ["bash", "-c", ATTEST_SCRIPT],
      Cmd: [],
      Tty: true,
      Labels: { "rakazo.egressProbe": "true" },
      HostConfig: {
        NetworkMode: "host",
        CapDrop: ["ALL"],
        CapAdd: ["NET_ADMIN"],
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
        setTimeout(() => resolve(undefined), ATTEST_DEADLINE_MS).unref(),
      ),
    ]);
    if (result?.StatusCode !== 0) {
      throw new Error(`the attestation probe exited ${result?.StatusCode ?? "late"}`);
    }
    // docker-modem streams the response only when `follow` is set; without it the
    // callback receives the whole buffered payload instead. TTY containers emit
    // raw logs, so no stream demultiplexing is needed either way.
    const logs = await new Promise<string>((resolve, reject) => {
      container!.logs({ stdout: true, stderr: false }, (error, data) => {
        if (error || !data) {
          reject(error ?? new Error("no attestation logs"));
          return;
        }
        const stream = data as unknown as NodeJS.ReadableStream;
        if (typeof stream.on !== "function") {
          resolve(String(data));
          return;
        }
        let text = "";
        stream.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        stream.on("end", () => resolve(text));
        stream.on("error", reject);
      });
    });
    verifyAttestation(logs);
  } finally {
    await container?.remove({ force: true }).catch(() => undefined);
  }
}
