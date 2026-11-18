import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { REQUIRED_V4_DROPS, REQUIRED_V6_DROPS } from "./egress-attest.js";
import {
  cleanupAbandonedProbeNetworks,
  EgressNotEnforced,
  egressProbeScript,
  egressProbeVerdict,
  verifyRestrictedEgress,
} from "./egress-probe.js";

// The attestation image name is irrelevant to these tests: fakeDocker answers any image.
const ensureAttestImage = async () => "attest:test";

// A valid attestation dump; egress-attest.test.ts owns the verification logic.
function validAttestation() {
  const rules = (drops: string[]) =>
    [
      "-A DOCKER-USER -i rakazo-c+ -o rakazo-c+ -j RETURN",
      ...drops.map((cidr) => `-A DOCKER-USER -i rakazo-c+ -d ${cidr} -j DROP`),
    ].join("\n");
  const input = [
    "-A INPUT -i rakazo-c+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    "-A INPUT -i rakazo-c+ -j DROP",
  ].join("\n");
  return [
    "==RAKAZO-V4USER==",
    rules(REQUIRED_V4_DROPS),
    "==RAKAZO-V4INPUT==",
    input,
    "==RAKAZO-V4FORWARD==",
    "-A FORWARD -j DOCKER-USER",
    "==RAKAZO-V6USER==",
    rules(REQUIRED_V6_DROPS),
    "==RAKAZO-V6INPUT==",
    input,
    "==RAKAZO-V6FORWARD==",
    "-A FORWARD -j DOCKER-USER",
    "==RAKAZO-IFINET6==",
    "00000000000000000000000000000001 01 80 10 80 lo",
    "==RAKAZO-DONE==",
  ].join("\n");
}

function fakeDocker({
  statusCode = 0,
  options,
  gateway = "172.30.0.1",
  createNetworkError,
  attestOutput = validAttestation(),
  attestStatusCode = 0,
}: {
  statusCode?: number;
  options?: Record<string, string>;
  gateway?: string;
  createNetworkError?: Error;
  attestOutput?: string;
  attestStatusCode?: number;
} = {}) {
  const container = {
    start: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue({ StatusCode: statusCode }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const attestContainer = {
    start: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue({ StatusCode: attestStatusCode }),
    logs: vi.fn().mockImplementation((_options, callback) => {
      const stream = new EventEmitter();
      callback(null, stream);
      setImmediate(() => {
        stream.emit("data", Buffer.from(attestOutput));
        stream.emit("end");
      });
      return stream;
    }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  let createdOptions: Record<string, string> | undefined;
  const network = {
    inspect: vi.fn().mockImplementation(async () => ({
      Options: options ?? createdOptions,
      IPAM: { Config: [{ Subnet: "fd00::/64", Gateway: "fd00::1" }, { Gateway: gateway }] },
    })),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const docker = {
    createNetwork: createNetworkError
      ? vi.fn().mockRejectedValue(createNetworkError)
      : vi.fn().mockImplementation(async (input) => {
          createdOptions = input.Options;
          return network;
        }),
    getNetwork: vi.fn().mockReturnValue(network),
    createContainer: vi
      .fn()
      .mockImplementation(async (input) =>
        input.HostConfig?.NetworkMode === "host" ? attestContainer : container,
      ),
  };
  return { docker: docker as unknown as Docker, raw: docker, container, network, attestContainer };
}

// Runs the probe's DNS lines against a UDP responder on 127.0.0.1; only the port differs from 53.
async function runDnsProbe(servers: string[], reply: (query: Buffer) => Buffer | undefined) {
  const responder = createSocket("udp4");
  responder.on("message", (query, peer) => {
    const answer = reply(query);
    if (answer) responder.send(answer, peer.port, peer.address);
  });
  await new Promise<void>((resolve) => responder.bind(0, "127.0.0.1", resolve));
  try {
    const { port } = responder.address() as AddressInfo;
    const lines = egressProbeScript("192.0.2.1", servers).split("\n");
    const dns = lines.slice(lines.findIndex((line) => line.includes("/dev/udp/")));
    const script = dns.join("\n").replaceAll("/dev/udp/$0/53 ", `/dev/udp/$0/${port} `);
    expect(script).toContain(`/dev/udp/$0/${port} `);
    expect(script).not.toContain("/53 ");
    return await new Promise<number | null>((resolve) =>
      spawn("bash", ["-c", script], { stdio: "ignore" }).on("exit", resolve),
    );
  } finally {
    responder.close();
  }
}

// A recursive A query for example.com, as a resolver would parse it.
const QUESTION = Buffer.from(
  "\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01",
  "latin1",
);

function answer(rcode: number) {
  return (query: Buffer) =>
    query.subarray(2).equals(QUESTION)
      ? Buffer.concat([query.subarray(0, 2), Buffer.from([0x81, 0x80 | rcode]), query.subarray(4)])
      : undefined;
}

describe("egress probe", () => {
  it("classifies probe exit codes", () => {
    expect(egressProbeVerdict(0)).toBe("enforced");
    expect(egressProbeVerdict(3)).toBe("host-reachable");
    expect(egressProbeVerdict(4)).toBe("metadata-reachable");
    expect(egressProbeVerdict(5)).toBe("dns-unreachable");
    expect(egressProbeVerdict(6)).toBe("inconclusive");
    expect(egressProbeVerdict(1)).toBe("inconclusive");
    expect(egressProbeVerdict(undefined)).toBe("inconclusive");
  });

  it("passes only when every connection to the gateway times out", () => {
    const script = egressProbeScript("172.30.0.1");
    expect(script).toContain("/dev/tcp/172.30.0.1/22");
    expect(script).toContain("/dev/tcp/172.30.0.1/1");
    expect(script).toContain("[ $? -eq 124 ] || exit 3");
    // Only an accepted metadata connection fails: hosts without one time out or are unreachable.
    expect(script).toContain("/dev/tcp/169.254.169.254/80' 2>/dev/null && exit 4");
    expect(script).not.toContain("/dev/udp");
    expect(script.trim().endsWith("exit 0")).toBe(true);
  });

  it("probes from a named rakazo-c bridge and cleans up", async () => {
    const { docker, raw, container, network } = fakeDocker();
    await expect(
      verifyRestrictedEgress(docker, "computer:test", undefined, ensureAttestImage),
    ).resolves.toBeUndefined();
    expect(
      raw.createNetwork.mock.calls[0]?.[0].Options["com.docker.network.bridge.name"],
    ).toHaveLength(15);
    expect(raw.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        Name: expect.stringMatching(/^rakazo-egress-probe-[a-f0-9]{7}$/),
        Options: {
          "com.docker.network.bridge.name": expect.stringMatching(/^rakazo-c[a-f0-9]{7}$/),
        },
      }),
    );
    expect(raw.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: "computer:test",
        Entrypoint: ["bash", "-c", egressProbeScript("172.30.0.1")],
        HostConfig: expect.objectContaining({
          NetworkMode: expect.stringMatching(/^rakazo-egress-probe-[a-f0-9]{7}$/),
          CapDrop: ["ALL"],
        }),
      }),
    );
    expect(container.remove).toHaveBeenCalledWith({ force: true });
    expect(network.remove).toHaveBeenCalledOnce();
  });

  it("checks the computers' configured IPv4 DNS servers", async () => {
    const { docker, raw } = fakeDocker();
    await verifyRestrictedEgress(docker, "computer:test", ["1.1.1.1"], ensureAttestImage);
    const script: string = raw.createContainer.mock.calls[0]?.[0].Entrypoint[2];
    expect(script).toBe(egressProbeScript("172.30.0.1", ["1.1.1.1"]));
    expect(script).toMatch(/' 1\.1\.1\.1 2>\/dev\/null && exit 0; done\nexit 5$/);
    // More than three servers is a configuration error, not a silent truncation.
    await expect(
      verifyRestrictedEgress(
        docker,
        "computer:test",
        ["1.1.1.1", "1.0.0.1", "9.9.9.9", "8.8.8.8"],
        ensureAttestImage,
      ),
    ).rejects.toThrow("more than three servers");
  });

  it("refuses IPv6 DNS servers instead of skipping them silently", async () => {
    const { docker } = fakeDocker();
    await expect(
      verifyRestrictedEgress(docker, "computer:test", ["2606:4700::1111"], ensureAttestImage),
    ).rejects.toThrow("SANDBOX_COMPUTER_DNS must list IPv4 servers");
    await expect(
      verifyRestrictedEgress(
        docker,
        "computer:test",
        ["1.1.1.1", "2606:4700::1111"],
        ensureAttestImage,
      ),
    ).rejects.toThrow("SANDBOX_COMPUTER_DNS must list IPv4 servers");
  });

  it("lets auto fall back to open despite unusable DNS settings when the rules are missing", async () => {
    // The DNS list is validated only once the rules are shown to be in place,
    // so a pre-ruleset install with a long or IPv6 DNS list keeps working.
    const { docker } = fakeDocker({ statusCode: 3 });
    await expect(
      verifyRestrictedEgress(docker, "computer:test", ["2606:4700::1111"], ensureAttestImage),
    ).rejects.toBeInstanceOf(EgressNotEnforced);
    await expect(
      verifyRestrictedEgress(
        docker,
        "computer:test",
        ["1.1.1.1", "1.0.0.1", "9.9.9.9", "8.8.8.8"],
        ensureAttestImage,
      ),
    ).rejects.toBeInstanceOf(EgressNotEnforced);
  });

  describe.skipIf(process.platform !== "linux")("DNS check", () => {
    it.each([
      ["NOERROR", 0],
      ["NXDOMAIN", 3],
      ["REFUSED", 5],
    ])("passes when a server replies %s", async (_name, rcode) => {
      expect(await runDnsProbe(["127.0.0.1"], answer(rcode))).toBe(0);
    });

    it("passes when a later server replies after an unreachable one", async () => {
      expect(await runDnsProbe(["127.0.0.2", "127.0.0.1"], answer(0))).toBe(0);
    });

    it("fails a reply to another query", async () => {
      const reply = (query: Buffer) =>
        answer(0)(Buffer.concat([Buffer.from("XX"), query.subarray(2)]));
      expect(await runDnsProbe(["127.0.0.1"], reply)).toBe(5);
    });

    it("passes when a server answers a resent query after losing the first", {
      timeout: 15_000,
    }, async () => {
      let received = 0;
      const reply = (query: Buffer) => (received++ === 0 ? undefined : answer(0)(query));
      expect(await runDnsProbe(["127.0.0.1"], reply)).toBe(0);
      expect(received).toBe(2);
    });

    it("fails when no server replies", { timeout: 15_000 }, async () => {
      expect(await runDnsProbe(["127.0.0.1"], () => undefined)).toBe(5);
    });
  });

  it("reports a partially removed ruleset even when the DNS check also fails", async () => {
    // The behavioral probe passes with a forwarded drop removed, and the DNS
    // verdict would say "no server answered" — but the firewall attestation
    // must run first, so the operator (and auto mode) sees the real problem.
    const partialRuleset = validAttestation().replace(
      "-A DOCKER-USER -i rakazo-c+ -d 10.0.0.0/8 -j DROP\n",
      "",
    );
    const { docker } = fakeDocker({ statusCode: 5, attestOutput: partialRuleset });
    await expect(
      verifyRestrictedEgress(docker, "computer:test", ["1.1.1.1"], ensureAttestImage),
    ).rejects.toBeInstanceOf(EgressNotEnforced);
  });

  it("refuses a probe that could not finish even when the rules are missing", async () => {
    // An inconclusive probe decides nothing: it must not fall through to the
    // attestation, where missing rules would read as EgressNotEnforced and
    // let auto settle open.
    const missingRules = validAttestation().replace(
      "-A DOCKER-USER -i rakazo-c+ -d 10.0.0.0/8 -j DROP\n",
      "",
    );
    const { docker } = fakeDocker({ statusCode: 6, attestOutput: missingRules });
    const error = await verifyRestrictedEgress(
      docker,
      "computer:test",
      undefined,
      ensureAttestImage,
    ).catch((error) => error);
    expect(error.constructor).toBe(Error);
    expect(error.message).toMatch(/the probe exited 6/);
  });

  it("fails closed when the probe setup never completes", async () => {
    // The deadline bounds every Docker call, not just the probe container: a
    // network creation that never returns must not hold the provision forever.
    vi.useFakeTimers();
    try {
      const container = {
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
        logs: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      const network = { remove: vi.fn().mockResolvedValue(undefined) };
      const docker = {
        createNetwork: vi.fn(() => new Promise(() => {})),
        getNetwork: vi.fn().mockReturnValue(network),
        createContainer: vi.fn().mockResolvedValue(container),
      } as unknown as Docker;
      const probe = verifyRestrictedEgress(docker, "computer:test", undefined, ensureAttestImage);
      const assertion = expect(probe).rejects.toThrow(/did not finish in time/);
      await vi.advanceTimersByTimeAsync(91_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a first-use image build take longer than the probe deadline", async () => {
    // The build runs after the behavioral probe settles, outside its deadline
    // race: a fresh build can legitimately take minutes and must not fail the
    // provision with the probe's timeout.
    vi.useFakeTimers();
    try {
      const { docker } = fakeDocker();
      const slowBuild = verifyRestrictedEgress(
        docker,
        "computer:test",
        undefined,
        () => new Promise((resolve) => setTimeout(() => resolve("attest:built"), 150_000)),
      );
      const assertion = expect(slowBuild).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(200_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses failed DNS without falling back to open egress", async () => {
    const { docker, container, network } = fakeDocker({ statusCode: 5 });
    const error = await verifyRestrictedEgress(
      docker,
      "computer:test",
      ["1.1.1.1"],
      ensureAttestImage,
    ).catch((error) => error);
    expect(error.constructor).toBe(Error);
    expect(error.message).toBe(
      "No SANDBOX_COMPUTER_DNS server answered from a restricted computer network; set servers reachable from there, such as public resolvers (see docs/self-host-docker-computers.md)",
    );
    expect(container.remove).toHaveBeenCalledWith({ force: true });
    expect(network.remove).toHaveBeenCalledOnce();
  });

  it("refuses a probe network name collision", async () => {
    const { docker } = fakeDocker({ createNetworkError: new Error("network already exists") });
    await expect(
      verifyRestrictedEgress(docker, "computer:test", undefined, ensureAttestImage),
    ).rejects.toThrow("already exists");
  });

  it.each([
    ["the host answered", { statusCode: 3 }, /reached the host/],
    ["the metadata endpoint answered", { statusCode: 4 }, /reached the metadata endpoint/],
    ["the probe failed", { statusCode: 125 }, /probe exited 125/],
    ["the attestation failed", { attestStatusCode: 1 }, /attestation probe exited 1/],
    [
      "the attestation shows a missing drop",
      { attestOutput: "==RAKAZO-V4USER==\niptables-failed\n==RAKAZO-DONE==\n" },
      /could not read v4 iptables/,
    ],
    ["the bridge is unnamed", { options: {} }, /lacks the named bridge/],
  ])("refuses when %s", async (_label, input, detail) => {
    const { docker, network } = fakeDocker(input);
    const result = verifyRestrictedEgress(docker, "computer:test", undefined, ensureAttestImage);
    await expect(result).rejects.toThrow(
      /restrict-computer-egress\.sh|could not verify|cannot verify|attestation|could not read/,
    );
    await expect(result).rejects.toThrow(detail);
    expect(network.remove).toHaveBeenCalledOnce();
  });

  it("removes only abandoned probe leftovers", async () => {
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    const oldSeconds = Math.floor((Date.now() - 30 * 60_000) / 1000);
    const networks = [
      {
        Name: "rakazo-egress-probe-aaaaaaaaa",
        info: { Created: old, Containers: {} },
      },
      {
        Name: "rakazo-egress-probe-bbbbbbbbb",
        info: { Created: old, Containers: { c: {} } },
      },
      {
        Name: "rakazo-egress-probe-ccccccccc",
        info: { Created: new Date().toISOString(), Containers: {} },
      },
      { Name: "someone-elses", info: { Created: old, Containers: {} } },
    ];
    const containers = [
      { Id: "old-probe", Created: oldSeconds, Labels: { "rakazo.egressProbe": "true" } },
      { Id: "new-probe", Created: Math.floor(Date.now() / 1000) - 5 },
      // Same age, but not a probe container: another install's workload.
      { Id: "foreign", Created: oldSeconds },
    ];
    const handles = new Map(
      networks.map(({ Name }) => [
        Name,
        { inspect: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) },
      ]),
    );
    for (const { Name, info } of networks) {
      handles.get(Name)?.inspect.mockResolvedValue(info);
    }
    const removedContainers: string[] = [];
    const docker = {
      listContainers: vi.fn().mockResolvedValue(containers),
      getContainer: vi.fn().mockImplementation((id: string) => ({
        remove: vi.fn().mockImplementation(async () => {
          removedContainers.push(id);
        }),
      })),
      listNetworks: vi
        .fn()
        .mockResolvedValue(
          networks.map(({ Name }) => ({ Name, Labels: { "rakazo.egressProbe": "true" } })),
        ),
      getNetwork: vi.fn().mockImplementation((name: string) => handles.get(name)),
    } as unknown as Docker;
    await cleanupAbandonedProbeNetworks(docker);
    expect(removedContainers).toEqual(["old-probe"]);
    expect(handles.get("rakazo-egress-probe-aaaaaaaaa")?.remove).toHaveBeenCalledOnce();
    expect(handles.get("rakazo-egress-probe-bbbbbbbbb")?.remove).not.toHaveBeenCalled();
    expect(handles.get("rakazo-egress-probe-ccccccccc")?.remove).not.toHaveBeenCalled();
    expect(handles.get("someone-elses")?.remove).not.toHaveBeenCalled();
  });
});
