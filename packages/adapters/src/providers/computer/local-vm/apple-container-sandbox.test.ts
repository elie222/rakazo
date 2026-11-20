import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AdapterContext, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSandboxReadLimit,
  assertSandboxWorkspaceContract,
  provisionPrepared,
} from "../../../computers/sandbox/sandbox-test-support.js";
import { AppleContainerSandboxProvider, localVmFirewall } from "./apple-container-sandbox.js";
import { fakeCli, removeFakeClis } from "./apple-container-sandbox.test-support.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

afterEach(removeFakeClis);

const ref = (name: string, botId = "bot-a"): ComputerRef => ({
  id: name,
  botId,
  kind: "local-vm",
  providerRef: name,
});

function firewallCalls(calls: { argv: string[]; stdin?: string }[]) {
  return calls.filter((call) => call.argv.includes("nft"));
}

async function collect(events: AsyncIterable<ProcessEvent>) {
  const out: ProcessEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("AppleContainerSandboxProvider", () => {
  it("starts the image command as the image user without privilege escalation", () => {
    const args = new AppleContainerSandboxProvider({ computerImage: "computer:test" }).runArgs(
      "rakazo-1",
      "bot-a",
    );
    expect(args.slice(0, 8)).toEqual([
      "run",
      "--detach",
      "--name",
      "rakazo-1",
      "--network",
      "rakazo-1",
      "--label",
      "rakazo.bot-id=bot-a",
    ]);
    expect(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 4)).toEqual([
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CAP_NET_ADMIN",
    ]);
    expect(args.slice(args.indexOf("--uid"), args.indexOf("--uid") + 4)).toEqual([
      "--uid",
      "1000",
      "--gid",
      "1000",
    ]);
    expect(args.slice(args.indexOf("computer:test"))).toEqual([
      "computer:test",
      "--no-new-privs",
      "--",
      "/usr/bin/env",
      "-u",
      "LD_PRELOAD",
      "/usr/local/bin/rakazo-computer",
    ]);
  });

  it("renders a firewall that only lets the gateway serve DNS and reach the screens", () => {
    const rules = localVmFirewall("192.168.70.1");
    expect(rules).toContain("ip daddr 192.168.70.1 meta l4proto { tcp, udp } th dport 53 accept");
    expect(rules.indexOf("th dport 53 accept")).toBeLessThan(
      rules.indexOf("ip daddr 192.168.70.1 reject"),
    );
    expect(rules).toContain("10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16");
    expect(rules).toContain("meta nfproto ipv6 reject");
    expect(rules).not.toContain("ip6 daddr");
    expect(rules).toContain("policy drop;");
    expect(rules).toContain("ip saddr 192.168.70.1 tcp dport { 6080, 6100 } accept");
    expect(() => localVmFirewall("192.168.70.1; flush ruleset")).toThrow(/invalid VM gateway/);
  });

  it("provisions a VM on its own network and locks it down as root", async () => {
    const fake = fakeCli();
    const computer = await fake.provider.provision(
      { botId: "bot-a", homePath: "/unused" },
      context,
    );
    expect(computer).toMatchObject({ botId: "bot-a", kind: "local-vm", fresh: true });
    const name = computer.providerRef!;
    const calls = fake.calls();
    expect(calls.map((call) => call.argv.slice(0, 2).join(" "))).toEqual(
      expect.arrayContaining(["network create", `run --detach`]),
    );
    expect(calls.find((call) => call.argv[0] === "network")!.argv).toEqual([
      "network",
      "create",
      name,
    ]);
    expect(calls.find((call) => call.argv[0] === "run")!.argv).toEqual(
      fake.provider.runArgs(name, "bot-a"),
    );
    const [apply, verify] = firewallCalls(calls);
    expect(apply!.argv).toEqual([
      "exec",
      "--uid",
      "0",
      "--gid",
      "0",
      "--interactive",
      name,
      "nft",
      "-f",
      "-",
    ]);
    expect(apply!.stdin).toBe(localVmFirewall("192.168.70.1"));
    expect(verify!.argv.slice(-4)).toEqual(["list", "table", "inet", "rakazo"]);
  });

  it("re-applies the firewall when reusing a running VM of the same bot", async () => {
    const fake = fakeCli({ "rakazo-old": { botId: "bot-a" } });
    const computer = await fake.provider.provision(
      { botId: "bot-a", homePath: "/unused", providerKind: "local-vm", providerRef: "rakazo-old" },
      context,
    );
    expect(computer).toMatchObject({ providerRef: "rakazo-old", fresh: false });
    expect(firewallCalls(fake.calls())).toHaveLength(2);
    expect(fake.calls().some((call) => call.argv[0] === "run")).toBe(false);
  });

  it("removes nothing when it cannot tell who owns a VM", async () => {
    const fake = fakeCli();
    await expect(fake.provider.stop(ref("rakazo-unreadable"))).rejects.toThrow(/inspect failed/);
    expect(fake.calls().some((call) => call.argv[0] === "rm")).toBe(false);
  });

  it("refuses a VM that belongs to another bot", async () => {
    const fake = fakeCli({ "rakazo-other": { botId: "bot-b" } });
    await expect(
      fake.provider.provision(
        {
          botId: "bot-a",
          homePath: "/unused",
          providerKind: "local-vm",
          providerRef: "rakazo-other",
        },
        context,
      ),
    ).rejects.toThrow(/belongs to another bot/);
    await expect(fake.provider.stop(ref("rakazo-other"))).rejects.toThrow(/another bot/);
    expect(Object.keys(fake.vms())).toEqual(["rakazo-other"]);
  });

  it("removes VMs an earlier start left for the same bot only", async () => {
    const fake = fakeCli({
      "rakazo-orphan": { botId: "bot-a", state: "stopped" },
      "rakazo-other": { botId: "bot-b" },
    });
    const computer = await fake.provider.provision(
      { botId: "bot-a", homePath: "/unused" },
      context,
    );
    expect(Object.keys(fake.vms()).sort()).toEqual([computer.providerRef, "rakazo-other"].sort());
    expect(fake.calls().map((call) => call.argv.join(" "))).toContain("network rm rakazo-orphan");
  });

  it("fails closed and removes the VM and network when the image has no nft", async () => {
    const fake = fakeCli({}, true);
    await expect(
      fake.provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow(/could not lock down its network; local-vm needs a computer image with nft/);
    const name = fake.calls().find((call) => call.argv[0] === "run")!.argv[3];
    expect(fake.vms()).toEqual({});
    expect(fake.calls().map((call) => call.argv.join(" "))).toContain(`network rm ${name}`);
  });

  it("removes a reused VM whose firewall cannot be applied", async () => {
    const fake = fakeCli({ "rakazo-old": { botId: "bot-a" } }, true);
    await expect(
      fake.provider.provision(
        {
          botId: "bot-a",
          homePath: "/unused",
          providerKind: "local-vm",
          providerRef: "rakazo-old",
        },
        context,
      ),
    ).rejects.toThrow(/needs a computer image with nft/);
    expect(fake.vms()).toEqual({});
  });

  it("streams output and the exit code, and passes stdin", async () => {
    const fake = fakeCli({ "rakazo-1": { botId: "bot-a" } });
    const events = await collect(
      fake.provider.execute(ref("rakazo-1"), { argv: ["printf", "hello"] }, context),
    );
    expect(events).toEqual([
      { type: "stdout", data: "out:hello" },
      { type: "stderr", data: "err" },
      { type: "exit", code: 7 },
    ]);
    const exec = fake.calls().at(-1)!.argv;
    expect(exec.slice(0, 7)).toEqual([
      "exec",
      "--interactive",
      "--uid",
      "1000",
      "--gid",
      "1000",
      "--workdir",
    ]);
    expect(exec.slice(exec.indexOf("rakazo-1"), exec.indexOf("rakazo-1") + 4)).toEqual([
      "rakazo-1",
      "setpriv",
      "--no-new-privs",
      "--",
    ]);

    await fake.provider.writeFile(
      ref("rakazo-1"),
      { path: "notes.txt", content: new TextEncoder().encode("secret notes") },
      context,
    );
    expect(fake.calls().at(-1)!.stdin).toBe("secret notes");
  });

  it("ends an aborted command with exit 130", async () => {
    const fake = fakeCli({ "rakazo-1": { botId: "bot-a" } });
    const controller = new AbortController();
    const running = collect(
      fake.provider.execute(
        ref("rakazo-1"),
        { argv: ["sleep", "30"] },
        { ...context, signal: controller.signal },
      ),
    );
    setTimeout(() => controller.abort(), 300);
    expect((await running).at(-1)).toEqual({ type: "exit", code: 130 });
  });

  it("refuses a file over a read's size limit by type and returns one at the limit", async () => {
    const content = new TextEncoder().encode("portable");
    const fake = fakeCli({ "rakazo-1": { botId: "bot-a" } }, false, {
      "/home/rakazo/notes/result.txt": content,
    });
    await assertSandboxReadLimit(fake.provider, ref("rakazo-1"), context, {
      path: "notes/result.txt",
      content,
    });
  });

  it("removes the VM and its network when stopped", async () => {
    const fake = fakeCli({ "rakazo-1": { botId: "bot-a" } });
    await fake.provider.stop(ref("rakazo-1"));
    expect(fake.vms()).toEqual({});
    expect(fake.calls().map((call) => call.argv.join(" "))).toEqual(
      expect.arrayContaining(["rm --force rakazo-1", "network rm rakazo-1"]),
    );
    expect(await fake.provider.isRunning(ref("rakazo-1"), context)).toBe(false);
  });
});

// Opt-in: needs Apple silicon, macOS 26 and a started `container` system service.
describe.runIf(process.env.VERIFY_LOCAL_VM === "1")("AppleContainerSandboxProvider (live)", () => {
  it(
    "runs a locked-down computer, its desktop and workspace contract, then removes it",
    async () => {
      const provider = new AppleContainerSandboxProvider({
        cli: process.env.LOCAL_VM_CLI,
        computerImage: process.env.LOCAL_VM_COMPUTER_IMAGE,
      });
      const computer = await provisionPrepared(
        provider,
        { botId: "live-bot", homePath: "/unused" },
        { ...context, botId: "live-bot" },
      );
      try {
        expect(await provider.isRunning(computer, context)).toBe(true);
        await assertSandboxWorkspaceContract(provider, computer, context);

        const observation = await provider.observe(computer, { ...context, botId: "live-bot" });
        expect(observation.width).toBeGreaterThan(0);
        if (process.env.LOCAL_VM_SCREENSHOT) {
          writeFileSync(process.env.LOCAL_VM_SCREENSHOT, observation.image);
        }
        const screen = await provider.connectScreen(
          computer,
          { view: "stream" },
          { ...context, botId: "live-bot" },
        );
        expect(screen.url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/embed\.html/);
        const page = await fetch(screen.url!.split("?")[0]!);
        expect(page.ok).toBe(true);
        await screen.close();

        const [record] = JSON.parse(
          execFileSync(
            process.env.LOCAL_VM_CLI || "container",
            ["inspect", computer.providerRef!],
            {
              encoding: "utf8",
            },
          ),
        );
        const gateway: string = record.status.networks[0].ipv4Gateway;
        const lanRouter = execFileSync("route", ["-n", "get", "default"], {
          encoding: "utf8",
        }).match(/gateway: (\S+)/)?.[1];
        const listener = createServer((socket) => socket.end("leak")).listen(0, "0.0.0.0");
        await new Promise((resolve) => listener.once("listening", resolve));
        const hostPort = (listener.address() as { port: number }).port;
        const run = async (script: string) => {
          const events = await collect(
            provider.execute(
              computer,
              { argv: ["bash", "-c", script], timeoutMs: 30_000 },
              context,
            ),
          );
          return events.find((event) => event.type === "exit")?.code;
        };
        try {
          expect(await run("/usr/sbin/nft flush ruleset")).not.toBe(0);
          expect(await run("curl -fsS -o /dev/null --max-time 15 https://example.com")).toBe(0);
          expect(await run(`curl -sS --max-time 5 http://${gateway}:${hostPort}/`)).not.toBe(0);
          if (lanRouter) {
            expect(await run(`curl -sS --max-time 5 http://${lanRouter}/`)).not.toBe(0);
          }
        } finally {
          listener.close();
        }

        const files: string[] = [];
        for await (const file of provider.exportWorkspace(computer, context)) files.push(file.path);
        expect(files.length).toBeGreaterThan(0);
      } finally {
        await provider.stop(computer);
      }
      expect(await provider.isRunning(computer, context)).toBe(false);
    },
    10 * 60_000,
  );
});
