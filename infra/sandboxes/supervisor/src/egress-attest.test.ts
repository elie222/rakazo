import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import {
  ATTEST_IMAGE,
  attestImageEnsurer,
  attestRestrictedEgress,
  parseAttestation,
  REQUIRED_V4_DROPS,
  REQUIRED_V6_DROPS,
  verifyAttestation,
} from "./egress-attest.js";
import { EgressNotEnforced } from "./egress-probe.js";

// The managed prefix exactly as restrict-computer-egress.sh leaves it in the
// kernel, in chain order (iptables may print -d before -i; normalization copes).
function managedIptables({ missingDrop }: { missingDrop?: string } = {}) {
  const v4Drops = REQUIRED_V4_DROPS.filter((cidr) => cidr !== missingDrop);
  const user = [
    "-A DOCKER-USER -i rakazo-c+ -o rakazo-c+ -j RETURN",
    ...v4Drops.map((cidr) => `-A DOCKER-USER -d ${cidr} -i rakazo-c+ -j DROP`),
  ].join("\n");
  const input = [
    "-A INPUT -i rakazo-c+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
    "-A INPUT -i rakazo-c+ -j DROP",
  ].join("\n");
  return [
    "==RAKAZO-V4USER==",
    user,
    "==RAKAZO-V4INPUT==",
    input,
    "==RAKAZO-V4FORWARD==",
    "-A FORWARD -j DOCKER-USER",
    "==RAKAZO-V6USER==",
    "==RAKAZO-V6USER==",
    [
      "-A DOCKER-USER -i rakazo-c+ -o rakazo-c+ -j RETURN",
      ...REQUIRED_V6_DROPS.map((cidr) => `-A DOCKER-USER -i rakazo-c+ -d ${cidr} -j DROP`),
    ].join("\n"),
    "==RAKAZO-V6INPUT==",
    "-A INPUT -i rakazo-c+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    "-A INPUT -i rakazo-c+ -j DROP",
    "==RAKAZO-V6FORWARD==",
    "-A FORWARD -j DOCKER-USER",
    "==RAKAZO-IFINET6==",
    "00000000000000000000000000000001 01 80 10 80 lo",
    "==RAKAZO-DONE==",
  ].join("\n");
}

describe("egress attestation", () => {
  it("accepts the managed ruleset", () => {
    expect(() => verifyAttestation(managedIptables())).not.toThrow();
  });

  it("rejects a ruleset with one private drop removed and the rest intact", () => {
    // The regression the sentinel could not catch: every other rule present,
    // 10.0.0.0/8 gone — computers could reach private networks again.
    expect(() => verifyAttestation(managedIptables({ missingDrop: "10.0.0.0/8" }))).toThrow(
      EgressNotEnforced,
    );
  });

  it("rejects a foreign rule inserted above the managed prefix", () => {
    const withForeign = managedIptables().replace(
      "==RAKAZO-V4USER==\n",
      "==RAKAZO-V4USER==\n-A DOCKER-USER -j ACCEPT\n",
    );
    expect(() => verifyAttestation(withForeign)).toThrow(EgressNotEnforced);
  });

  it("rejects a missing DOCKER-USER chain", () => {
    const missing = managedIptables().replace(
      "==RAKAZO-V4USER==\n",
      "==RAKAZO-V4USER==\niptables: No chain/target/match by that name.\n",
    );
    expect(() => verifyAttestation(missing)).toThrow(/could not read/);
  });

  it("requires the IPv6 family only on a host with global IPv6", () => {
    const noV6Binary = managedIptables().replace(
      /==RAKAZO-V6USER==\n.*\n==RAKAZO-V6INPUT==/s,
      "==RAKAZO-V6USER==\nip6tables-absent\n==RAKAZO-V6INPUT==",
    );
    expect(() => verifyAttestation(noV6Binary)).not.toThrow();
    const globalV6 = noV6Binary.replace(
      "==RAKAZO-IFINET6==\n",
      "==RAKAZO-IFINET6==\n20010db8000000000000000000000001 02 40 00 00 eth0\n",
    );
    // A failed probe command cannot establish that host rules are absent.
    expect(() => verifyAttestation(globalV6)).not.toThrow(EgressNotEnforced);
    expect(() => verifyAttestation(globalV6)).toThrow(/could not read v6 iptables/);
  });

  it("refuses unreadable or malformed host IPv6 state", () => {
    for (const value of ["ifinet6-unreadable", "malformed"]) {
      const output = managedIptables().replace(
        "==RAKAZO-IFINET6==\n",
        `==RAKAZO-IFINET6==\n${value}\n`,
      );
      expect(() => verifyAttestation(output)).not.toThrow(EgressNotEnforced);
      expect(() => verifyAttestation(output)).toThrow(/host IPv6 state/);
    }
  });

  it("rejects truncated or empty attestation output", () => {
    expect(() => verifyAttestation("")).toThrow(/no output/);
    expect(() => verifyAttestation("==RAKAZO-V4USER==\n-A DOCKER-USER -j RETURN")).toThrow(
      /no output/,
    );
  });

  it("builds the probe image from the repository context only when missing", async () => {
    const context = mkdtempSync(path.join(tmpdir(), "rakazo-attest-"));
    writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");
    const followProgress = vi.fn().mockImplementation((_stream, finished) => finished(undefined));
    const buildImage = vi.fn().mockImplementation((_context, _options, callback) => {
      callback(null, {});
      return {};
    });
    const present = {
      modem: { followProgress },
      getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
      buildImage,
    } as unknown as Docker;
    await expect(attestImageEnsurer(present, context)()).resolves.toBeUndefined();
    expect(buildImage).not.toHaveBeenCalled();
    const missing = {
      modem: { followProgress },
      getImage: vi.fn().mockReturnValue({
        inspect: vi.fn().mockRejectedValue({ statusCode: 404 }),
      }),
      buildImage,
    } as unknown as Docker;
    await expect(attestImageEnsurer(missing, context)()).resolves.toBeUndefined();
    expect(buildImage).toHaveBeenCalledWith(
      { context, src: ["Dockerfile"] },
      expect.objectContaining({ t: ATTEST_IMAGE, version: "2" }),
      expect.any(Function),
    );
  });

  it("fails closed when the probe image cannot be built (offline daemon)", async () => {
    const followProgress = vi
      .fn()
      .mockImplementation((_stream, finished) =>
        finished(new Error("failed to solve: no network")),
      );
    const docker = {
      modem: { followProgress },
      getImage: vi.fn().mockReturnValue({
        inspect: vi.fn().mockRejectedValue({ statusCode: 404 }),
      }),
      buildImage: vi.fn().mockImplementation((_context, _options, callback) => {
        callback(null, {});
        return {};
      }),
    } as unknown as Docker;
    const context = mkdtempSync(path.join(tmpdir(), "rakazo-attest-"));
    writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");
    await expect(attestImageEnsurer(docker, context)()).rejects.toThrow(/no network/);
  });

  // docker-modem only streams log responses when `follow` is set; without it
  // the callback receives the whole buffered payload instead, so the probe must
  // accept both shapes.
  it("reads attestation logs delivered as a buffered payload", async () => {
    const container = {
      start: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
      logs: vi.fn().mockImplementation((_options, callback) => {
        callback(null, Buffer.from(managedIptables()));
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const docker = {
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Docker;
    await expect(attestRestrictedEgress(docker, "computer:test")).resolves.toBeUndefined();
  });

  it("ships the attestation build context with the supervisor image", () => {
    const root = path.resolve(import.meta.dirname, "../../../..");
    const file = readFileSync(path.join(root, "infra/sandboxes/supervisor/Dockerfile"), "utf8");
    expect(file).toContain("COPY infra/sandboxes/egress-attest infra/sandboxes/egress-attest");
    expect(existsSync(path.join(root, "infra/sandboxes/egress-attest/Dockerfile"))).toBe(true);
  });

  it("treats an unreadable INPUT chain as unverifiable, not as missing rules", () => {
    // If INPUT cannot be read, nothing is proven either way; classifying it as
    // EgressNotEnforced would let `auto` silently fall back to open egress.
    const unreadable = managedIptables().replace(
      "==RAKAZO-V4INPUT==\n",
      "==RAKAZO-V4INPUT==\niptables: Permission denied (you must be root)\n",
    );
    expect(() => verifyAttestation(unreadable)).toThrow(/could not read v4 iptables/);
    expect(() => verifyAttestation(unreadable)).not.toThrow(EgressNotEnforced);
  });

  it("rejects a FORWARD chain that never jumps to DOCKER-USER", () => {
    // The managed rules can be perfectly intact and still enforce nothing.
    const detached = managedIptables().replace(
      "==RAKAZO-V4FORWARD==\n-A FORWARD -j DOCKER-USER\n",
      "==RAKAZO-V4FORWARD==\n-A FORWARD -o docker0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT\n",
    );
    expect(() => verifyAttestation(detached)).toThrow(
      /does not jump to DOCKER-USER, so the managed rules are not attached/,
    );
    expect(() => verifyAttestation(detached)).toThrow(EgressNotEnforced);
  });

  it("fails closed when FORWARD filters traffic before DOCKER-USER", () => {
    const shadowed = managedIptables().replace(
      "==RAKAZO-V4FORWARD==\n",
      "==RAKAZO-V4FORWARD==\n-A FORWARD -i rakazo-c+ -j ACCEPT\n",
    );
    expect(() => verifyAttestation(shadowed)).toThrow(
      /FORWARD chain filters traffic before DOCKER-USER/,
    );
    expect(() => verifyAttestation(shadowed)).not.toThrow(EgressNotEnforced);
  });

  it("treats an unreadable (not absent) IPv6 chain as unverifiable on a global-IPv6 host", () => {
    const denied = managedIptables()
      .replace(
        /==RAKAZO-V6USER==\n.*\n==RAKAZO-V6INPUT==/s,
        "==RAKAZO-V6USER==\nip6tables v1.8.9 (nf_tables): Permission denied\n==RAKAZO-V6INPUT==",
      )
      .replace(
        "==RAKAZO-IFINET6==\n",
        "==RAKAZO-IFINET6==\n20010db8000000000000000000000001 02 40 00 00 eth0\n",
      );
    expect(() => verifyAttestation(denied)).toThrow(/could not read v6 iptables/);
    expect(() => verifyAttestation(denied)).not.toThrow(EgressNotEnforced);
  });

  it("splits the dump into sections", () => {
    const sections = parseAttestation("==RAKAZO-A==\n1\n2\n==RAKAZO-B==\nx");
    expect(sections.A).toBe("1\n2");
    expect(sections.B).toBe("x");
  });

  it("runs the probe in the host namespace with NET_ADMIN only", async () => {
    const container = {
      start: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
      logs: vi.fn().mockImplementation((_options, callback) => {
        const stream = new EventEmitter();
        callback(null, stream);
        setImmediate(() => {
          stream.emit("data", Buffer.from(managedIptables()));
          stream.emit("end");
        });
        return stream;
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const docker = {
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Docker;
    await expect(attestRestrictedEgress(docker, "computer:test")).resolves.toBeUndefined();
    const options = (docker as unknown as { createContainer: ReturnType<typeof vi.fn> })
      .createContainer.mock.calls[0]?.[0];
    expect(options.HostConfig).toEqual(
      expect.objectContaining({
        NetworkMode: "host",
        CapDrop: ["ALL"],
        CapAdd: ["NET_ADMIN"],
        ReadonlyRootfs: true,
      }),
    );
    expect(options.Labels).toEqual({ "rakazo.egressProbe": "true" });
    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });

  it("fails closed when the probe cannot finish", async () => {
    const container = {
      start: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue({ StatusCode: 1 }),
      logs: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const docker = {
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Docker;
    await expect(attestRestrictedEgress(docker, "computer:test")).rejects.toThrow(
      /attestation probe exited 1/,
    );
  });

  // The required rule lists and the installer must never drift apart: run the
  // script's --print with stubbed firewall binaries and compare rule for rule.
  it("matches the rules restrict-computer-egress.sh installs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rakazo-attest-"));
    for (const tool of ["iptables", "ip6tables"]) {
      writeFileSync(path.join(dir, tool), "#!/usr/bin/env bash\nexit 99\n", { mode: 0o755 });
    }
    const script = path.resolve(
      import.meta.dirname,
      "../../../../infra/compose/restrict-computer-egress.sh",
    );
    const printed = spawnSync("bash", ["-c", `PATH="${dir}:$PATH" bash '${script}' --print`], {
      encoding: "utf8",
    });
    expect(printed.status).toBe(0);
    const emitted = printed.stdout
      .split("\n")
      .filter((line) => /^(ip6tables|iptables) -I (DOCKER-USER|INPUT) /.test(line));
    for (const cidr of [...REQUIRED_V4_DROPS, ...REQUIRED_V6_DROPS]) {
      const family = REQUIRED_V4_DROPS.includes(cidr) ? "iptables" : "ip6tables";
      expect(emitted).toContain(`${family} -I DOCKER-USER 1 -i rakazo-c+ -d ${cidr} -j DROP`);
    }
    expect(emitted).toContain("iptables -I DOCKER-USER 1 -i rakazo-c+ -o rakazo-c+ -j RETURN");
    expect(emitted).toContain("ip6tables -I DOCKER-USER 1 -i rakazo-c+ -o rakazo-c+ -j RETURN");
    expect(emitted).toContain(
      "iptables -I INPUT 1 -i rakazo-c+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    );
    expect(emitted).toContain("iptables -I INPUT 1 -i rakazo-c+ -j DROP");
    // Nothing else is managed: the counts pin the full rule set.
    expect(emitted.filter((line) => line.startsWith("iptables "))).toHaveLength(
      2 + 1 + REQUIRED_V4_DROPS.length,
    );
    expect(emitted.filter((line) => line.startsWith("ip6tables "))).toHaveLength(
      2 + 1 + REQUIRED_V6_DROPS.length,
    );
  });
});
