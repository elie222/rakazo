import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import {
  ATTEST_IMAGE,
  ATTEST_SCRIPT,
  attestImageEnsurer,
  attestRestrictedEgress,
  expectedAttestImage,
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
    // The error must name the rule found above the managed prefix, even when
    // it sits at index 0 and displaces the whole prefix.
    expect(() => verifyAttestation(withForeign)).toThrow(
      /rules above the managed prefix \(-j ACCEPT\)/,
    );
    expect(() => verifyAttestation(withForeign)).not.toThrow(EgressNotEnforced);
  });

  it("rejects a foreign rule at the head of INPUT without falling back to open", () => {
    // A Tailscale or libvirt rule inserted at the top of INPUT must not read as
    // "rules not installed" in auto mode.
    const withForeign = managedIptables().replace(
      "==RAKAZO-V4INPUT==\n",
      "==RAKAZO-V4INPUT==\n-A INPUT -i tailscale0 -j ACCEPT\n",
    );
    expect(() => verifyAttestation(withForeign)).toThrow(
      /rules above the managed prefix \(-i tailscale0 -j ACCEPT\)/,
    );
    expect(() => verifyAttestation(withForeign)).not.toThrow(EgressNotEnforced);
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

  it("accepts a host where /proc/net/if_inet6 is absent (IPv6 disabled)", () => {
    // The kernel without IPv6 has no if_inet6 file at all; the install script
    // reads that as "no IPv6" and skips the v6 rules, so verification must too.
    const noV6 = managedIptables().replace(
      /==RAKAZO-IFINET6==\n.*/,
      "==RAKAZO-IFINET6==\nifinet6-absent",
    );
    expect(() => verifyAttestation(noV6)).not.toThrow();
  });

  it("does not mistake an interface named like a marker for absent IPv6", () => {
    // A host interface whose name contains the marker string must not read as
    // "IPv6 disabled": here it carries a global address and the v6 rules are
    // unreadable, so verification must fail rather than skip the family.
    const fakeInterface = managedIptables()
      .replace(
        /==RAKAZO-V6USER==\n.*\n==RAKAZO-V6INPUT==/s,
        "==RAKAZO-V6USER==\nip6tables-absent\n==RAKAZO-V6INPUT==",
      )
      .replace(
        /==RAKAZO-IFINET6==\n.*/,
        "==RAKAZO-IFINET6==\n20010db8000000000000000000000001 02 40 00 00 ifinet6-absent",
      );
    expect(() => verifyAttestation(fakeInterface)).toThrow(/could not read v6 iptables/);
    expect(() => verifyAttestation(fakeInterface)).not.toThrow(EgressNotEnforced);
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

  it("builds the probe image from the repository context only when its tag is missing", async () => {
    const context = mkdtempSync(path.join(tmpdir(), "rakazo-attest-"));
    writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");
    const expectedTag = createHash("sha256")
      .update(readFileSync(path.join(context, "Dockerfile")))
      .digest("hex")
      .slice(0, 16);
    const expectedImage = `${ATTEST_IMAGE}:${expectedTag}`;
    const buildImage = vi.fn().mockResolvedValue(Readable.from(['{"stream":"built"}\n']));
    const present = {
      getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
      buildImage,
    } as unknown as Docker;
    await expect(attestImageEnsurer(present, context)()).resolves.toBe(expectedImage);
    expect(buildImage).not.toHaveBeenCalled();
    const inspect = vi.fn().mockRejectedValueOnce({ statusCode: 404 }).mockResolvedValue({});
    const missing = {
      getImage: vi.fn().mockReturnValue({ inspect }),
      buildImage,
    } as unknown as Docker;
    await expect(attestImageEnsurer(missing, context)()).resolves.toBe(expectedImage);
    expect(buildImage).toHaveBeenCalledWith(
      { context, src: ["Dockerfile"] },
      expect.objectContaining({
        t: expectedImage,
        version: "2",
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("rebuilds the probe image when the Dockerfile content changes", async () => {
    const context = mkdtempSync(path.join(tmpdir(), "rakazo-attest-"));
    writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");
    const firstTag = createHash("sha256")
      .update(readFileSync(path.join(context, "Dockerfile")))
      .digest("hex")
      .slice(0, 16);
    const inspect = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 404 }) // first build
      .mockResolvedValueOnce({}) // first build verified
      .mockRejectedValueOnce({ statusCode: 404 }) // changed Dockerfile
      .mockResolvedValueOnce({}); // second build verified
    const buildImage = vi
      .fn()
      .mockResolvedValueOnce(Readable.from(['{"stream":"built"}\n']))
      .mockResolvedValueOnce(Readable.from(['{"stream":"built again"}\n']));
    const docker = {
      getImage: vi.fn().mockReturnValue({ inspect }),
      buildImage,
    } as unknown as Docker;
    const first = await attestImageEnsurer(docker, context)();
    expect(first).toBe(`${ATTEST_IMAGE}:${firstTag}`);
    // A host that already has the first build still rebuilds after the context
    // changes: the new content hashes to a new tag the engine does not have.
    writeFileSync(path.join(context, "Dockerfile"), "FROM scratch AS changed\n");
    const second = await attestImageEnsurer(docker, context)();
    const secondTag = createHash("sha256")
      .update(readFileSync(path.join(context, "Dockerfile")))
      .digest("hex")
      .slice(0, 16);
    expect(second).toBe(`${ATTEST_IMAGE}:${secondTag}`);
    expect(second).not.toBe(first);
    expect(buildImage).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the build reports an error in its progress stream", async () => {
    const docker = {
      getImage: vi
        .fn()
        .mockReturnValue({ inspect: vi.fn().mockRejectedValue({ statusCode: 404 }) }),
      buildImage: vi.fn().mockResolvedValue(Readable.from(['{"error":"no network"}\n'])),
    } as unknown as Docker;
    const context = mkdtempSync(path.join(tmpdir(), "rakazo-attest-"));
    writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");
    // The message must name the exact tag, so offline operators know what to
    // build or load (Docker's own reason goes to the log instead).
    await expect(attestImageEnsurer(docker, context)()).rejects.toThrow(
      `could not build ${expectedAttestImage(context)} from infra/sandboxes/egress-attest; build or load that exact tag on the Docker host (see docs/self-host-restricted-network.md)`,
    );
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
    // The required drop lists are parsed from the installer at runtime, so the
    // script must be inside the image too.
    expect(file).toContain(
      "COPY infra/compose/restrict-computer-egress.sh infra/compose/restrict-computer-egress.sh",
    );
  });

  it("parses the required drop lists from the installer script", () => {
    // The installer is the single source of truth; these assertions pin the
    // parser against heredoc format drift, not the exact policy.
    expect(REQUIRED_V4_DROPS).toContain("10.0.0.0/8");
    expect(REQUIRED_V4_DROPS).toContain("192.168.0.0/16");
    expect(REQUIRED_V4_DROPS.length).toBeGreaterThan(8);
    expect(REQUIRED_V6_DROPS).toContain("fc00::/7");
    expect(REQUIRED_V6_DROPS.length).toBeGreaterThan(2);
    for (const cidr of [...REQUIRED_V4_DROPS, ...REQUIRED_V6_DROPS]) {
      expect(cidr).toMatch(/^\S+\/\d+$/);
    }
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
      /rules above the DOCKER-USER jump .* could bypass the managed rules/,
    );
    expect(() => verifyAttestation(shadowed)).not.toThrow(EgressNotEnforced);
  });

  it("treats an ambiguous iptables backend as unverifiable", () => {
    // When both the nft and legacy views hold a FORWARD and DOCKER-USER chain,
    // there is no telling which one Docker filters through.
    const ambiguous = managedIptables()
      .replace("==RAKAZO-V4USER==\n", "==RAKAZO-V4USER==\niptables-ambiguous\n")
      .replace("==RAKAZO-V4INPUT==\n", "==RAKAZO-V4INPUT==\niptables-ambiguous\n")
      .replace("==RAKAZO-V4FORWARD==\n", "==RAKAZO-V4FORWARD==\niptables-ambiguous\n");
    expect(() => verifyAttestation(ambiguous)).toThrow(/could not read v4 iptables/);
    expect(() => verifyAttestation(ambiguous)).not.toThrow(EgressNotEnforced);
  });

  it("treats an ip6tables command failure as unverifiable", () => {
    const output = managedIptables()
      .replace(
        /==RAKAZO-V6USER==\n.*\n==RAKAZO-V6INPUT==/s,
        "==RAKAZO-V6USER==\nip6tables-failed\n==RAKAZO-V6INPUT==",
      )
      .replace(
        "==RAKAZO-IFINET6==\n",
        "==RAKAZO-IFINET6==\n20010db8000000000000000000000001 02 40 00 00 eth0\n",
      );
    expect(() => verifyAttestation(output)).toThrow(/could not read v6 iptables/);
    expect(() => verifyAttestation(output)).not.toThrow(EgressNotEnforced);
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
        CapAdd: ["NET_ADMIN", "NET_RAW"],
        ReadonlyRootfs: true,
        Tmpfs: { "/run": "rw" },
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

  it("fails closed when the attestation logs never finish streaming", async () => {
    // A log stream that never ends must not hold the provision (and its
    // cleanup) forever: the deadline covers the log request, not just the exit.
    vi.useFakeTimers();
    try {
      const container = {
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
        logs: vi.fn().mockImplementation((_options, callback) => {
          callback(null, new EventEmitter());
        }),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      const docker = {
        createContainer: vi.fn().mockResolvedValue(container),
      } as unknown as Docker;
      const probe = attestRestrictedEgress(docker, "computer:test");
      const assertion = expect(probe).rejects.toThrow(/did not finish streaming/);
      await vi.advanceTimersByTimeAsync(31_000);
      await assertion;
      expect(container.remove).toHaveBeenCalledWith({ force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the attestation container is never created", async () => {
    // The deadline bounds the whole attestation lifecycle — creation, start,
    // logs, cleanup — not just the container's exit.
    vi.useFakeTimers();
    try {
      const docker = {
        createContainer: vi.fn(() => new Promise(() => {})),
      } as unknown as Docker;
      const probe = attestRestrictedEgress(docker, "attest:test");
      const assertion = expect(probe).rejects.toThrow(/the attestation did not finish in time/);
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  // The attest script must read the same iptables backend Docker and the
  // installer wrote to: Debian's default `iptables` is the nft variant, so the
  // script picks per family the variant whose FORWARD and DOCKER-USER chains
  // exist. Stubs mirror that split: legacy holds the managed rules, nft has no
  // Docker chains, and `cat` stands in for /proc/net/if_inet6.
  it("reads the rules through the iptables backend that holds Docker's chains", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rakazo-attest-"));
    for (const tool of ["iptables-nft", "ip6tables-nft", "ip6tables-legacy"]) {
      writeFileSync(path.join(dir, tool), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    }
    const dump = [
      'case "$4" in',
      "  DOCKER-USER)",
      "    printf '%s\\n' '-A DOCKER-USER -i rakazo-c+ -o rakazo-c+ -j RETURN' " +
        REQUIRED_V4_DROPS.map((cidr) => `'-A DOCKER-USER -i rakazo-c+ -d ${cidr} -j DROP'`).join(
          " ",
        ) +
        "    ;;",
      "  INPUT)",
      "    printf '%s\\n' '-A INPUT -i rakazo-c+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT' '-A INPUT -i rakazo-c+ -j DROP'",
      "    ;;",
      "  FORWARD)",
      "    echo '-A FORWARD -j DOCKER-USER'",
      "    ;;",
      "esac",
    ].join("\n");
    writeFileSync(path.join(dir, "iptables-legacy"), `#!/usr/bin/env bash\n${dump}\n`, {
      mode: 0o755,
    });
    writeFileSync(
      path.join(dir, "cat"),
      "#!/usr/bin/env bash\necho '00000000000000000000000000000001 01 80 10 80 lo'\n",
      { mode: 0o755 },
    );
    const run = spawnSync("bash", ["-c", ATTEST_SCRIPT], {
      encoding: "utf8",
      env: { PATH: `${dir}:/usr/bin:/bin` },
    });
    expect(run.status).toBe(0);
    // The nft stub fails, so any v4 output can only come from the legacy one.
    expect(run.stdout).toContain("-A FORWARD -j DOCKER-USER");
    expect(run.stdout).toContain("iptables-failed");
    expect(() => verifyAttestation(run.stdout)).not.toThrow();
  });

  it("treats a host with both iptables backends as unverifiable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rakazo-attest-"));
    for (const tool of ["iptables-nft", "iptables-legacy", "ip6tables-nft", "ip6tables-legacy"]) {
      writeFileSync(path.join(dir, tool), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    }
    writeFileSync(
      path.join(dir, "cat"),
      "#!/usr/bin/env bash\necho '00000000000000000000000000000001 01 80 10 80 lo'\n",
      { mode: 0o755 },
    );
    const run = spawnSync("bash", ["-c", ATTEST_SCRIPT], {
      encoding: "utf8",
      env: { PATH: `${dir}:/usr/bin:/bin` },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("iptables-ambiguous");
    expect(() => verifyAttestation(run.stdout)).toThrow(/could not read v4 iptables/);
  });

  // The strongest form of the single-source check: an attestation dump built
  // directly from the installer's --print output must verify. If either side
  // drifts — the rules the installer writes or the rules attestation requires —
  // this fails.
  it("accepts an attestation dump built from the installer's --print output", () => {
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
    // --print emits one reverse pass of -I commands; per chain, the final order
    // is the reverse of the printed order.
    const sections: Record<string, string[]> = { V4USER: [], V4INPUT: [], V6USER: [], V6INPUT: [] };
    for (const line of printed.stdout.split("\n")) {
      const match = /^(ip6?tables) -I (DOCKER-USER|INPUT) 1 (.+)$/.exec(line.trim());
      if (!match) continue;
      const family = match[1] === "iptables" ? "V4" : "V6";
      const section = `${family}${match[2] === "INPUT" ? "INPUT" : "USER"}`;
      sections[section]?.unshift(`-A ${match[2]} ${match[3]}`);
    }
    const dump = [
      "==RAKAZO-V4USER==",
      (sections.V4USER ?? []).join("\n"),
      "==RAKAZO-V4INPUT==",
      (sections.V4INPUT ?? []).join("\n"),
      "==RAKAZO-V4FORWARD==",
      "-A FORWARD -j DOCKER-USER",
      "==RAKAZO-V6USER==",
      (sections.V6USER ?? []).join("\n"),
      "==RAKAZO-V6INPUT==",
      (sections.V6INPUT ?? []).join("\n"),
      "==RAKAZO-V6FORWARD==",
      "-A FORWARD -j DOCKER-USER",
      "==RAKAZO-IFINET6==",
      "00000000000000000000000000000001 01 80 10 80 lo",
      "==RAKAZO-DONE==",
    ].join("\n");
    expect(() => verifyAttestation(dump)).not.toThrow();
    // Nothing else is managed: the counts pin the full rule set, so an extra
    // installer rule cannot slip past verification as "not required".
    const emitted = printed.stdout
      .split("\n")
      .filter((line) => /^(ip6?tables) -I (DOCKER-USER|INPUT) /.test(line));
    expect(emitted.filter((line) => line.startsWith("iptables "))).toHaveLength(
      2 + 1 + REQUIRED_V4_DROPS.length,
    );
    expect(emitted.filter((line) => line.startsWith("ip6tables "))).toHaveLength(
      2 + 1 + REQUIRED_V6_DROPS.length,
    );
  });
});
