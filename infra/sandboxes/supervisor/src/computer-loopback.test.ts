import type * as NodeFsPromises from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPUTER_IMAGE,
  computerBridgeNameFor,
  computerNetworkNameFor,
  computerNetworkOwnerFor,
  containerNameFor,
  hostComputerUser,
} from "./computer-spec.js";

const mocks = vi.hoisted(() => ({
  docker: {
    version: vi.fn(),
    getImage: vi.fn(),
    getContainer: vi.fn(),
    listContainers: vi.fn(),
    createContainer: vi.fn(),
    createNetwork: vi.fn(),
    getNetwork: vi.fn(),
    listNetworks: vi.fn(),
  },
  assertHomeWritable: vi.fn(),
}));
vi.mock("dockerode", () => ({
  default: class {
    version = mocks.docker.version;
    getImage = mocks.docker.getImage;
    getContainer = mocks.docker.getContainer;
    listContainers = mocks.docker.listContainers;
    createContainer = mocks.docker.createContainer;
    createNetwork = mocks.docker.createNetwork;
    getNetwork = mocks.docker.getNetwork;
    listNetworks = mocks.docker.listNetworks;
  },
}));
vi.mock("./home-ownership.js", () => ({ assertComputerHomeWritable: mocks.assertHomeWritable }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  mkdir: vi.fn(),
}));

let screen: http.Server;
let screenPort: string;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("HOSTNAME", "");
  vi.stubEnv("DATA_DIR", "/tmp/rakazo-loopback-test");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "published");
  vi.stubEnv("SANDBOX_SCREEN_HOST", "127.0.0.1");
  screen = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => screen.listen(0, "127.0.0.1", resolve));
  const address = screen.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP address");
  screenPort = String(address.port);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => {
    screen.close(() => resolve());
    screen.closeAllConnections();
  });
});

describe("computer loopback provision lifecycle", () => {
  it.each([
    { error: new Error("daemon unavailable"), status: 500 },
    { error: Object.assign(new Error("permission denied"), { statusCode: 403 }), status: 500 },
    { error: Object.assign(new Error("container missing"), { statusCode: 404 }), status: 404 },
  ])("reports inspection failures correctly when stopping: $status", async ({ error, status }) => {
    const { supervisorApp } = await import("./index.js");
    const container = { inspect: vi.fn().mockRejectedValue(error), stop: vi.fn(), exec: vi.fn() };
    mocks.docker.getContainer.mockReturnValue(container);
    const response = await supervisorApp.request("/computers/inspect-failure/stop", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
    });
    expect(response.status).toBe(status);
    expect(container.stop).not.toHaveBeenCalled();
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("rejects another computer identity without stopping its container", async () => {
    const { supervisorApp } = await import("./index.js");
    const container = {
      inspect: vi.fn().mockResolvedValue({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "other", "rakazo.spaceId": "other" },
        },
      }),
      stop: vi.fn(),
      exec: vi.fn(),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const response = await supervisorApp.request("/computers/identity-mismatch/stop", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
    });
    expect(response.status).toBe(403);
    expect(container.stop).not.toHaveBeenCalled();
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("rechecks stopped state after a concurrent stop owns the screen lock", async () => {
    const { supervisorApp } = await import("./index.js");
    let running = true;
    let releaseStop!: () => void;
    let stopStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const container = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        State: { Running: running },
      })),
      exec: vi.fn(async () => {
        if (!running) throw new Error("container stopped");
        return { start: async () => Readable.from([]), inspect: async () => ({ ExitCode: 0 }) };
      }),
      stop: vi.fn(async () => {
        stopStarted();
        await stopped;
        running = false;
      }),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const stop = () =>
      supervisorApp.request("/computers/concurrent-stop/stop", {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
          "x-rakazo-bot-id": "bot",
          "x-rakazo-space-id": "space",
        },
      });
    const first = stop();
    await started;
    const second = stop();
    await vi.waitFor(() => expect(container.inspect).toHaveBeenCalledTimes(3));
    releaseStop();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(container.stop).toHaveBeenCalledOnce();
    expect(container.exec).toHaveBeenCalledOnce();
  });

  it("stops the computer after a failed checkpoint while reporting the failure", async () => {
    const { supervisorApp } = await import("./index.js");
    const container = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        State: { Running: true },
      })),
      exec: vi.fn(async () => ({
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: 1 }),
      })),
      stop: vi.fn(async () => {}),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const response = await supervisorApp.request("/computers/failed-checkpoint/stop", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
    });
    expect(response.status).toBe(500);
    expect(container.stop).toHaveBeenCalledOnce();
  });

  it("quiesces browser profiles with Browser.close before stopping the container", async () => {
    const { supervisorApp } = await import("./index.js");
    const container = {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        State: { Running: true },
      })),
      exec: vi.fn(async (_options: { Cmd?: string[] }) => ({
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: 0 }),
      })),
      stop: vi.fn(async () => {}),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const response = await supervisorApp.request("/computers/quiesce-before-stop/stop", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
    });
    expect(response.status).toBe(200);
    const command = String(container.exec.mock.calls[0]?.[0]?.Cmd?.[2] ?? "");
    expect(command).toContain("Browser.close");
    expect(command).toContain(".browser-profiles'/chromium ");
    expect(command).toContain(".browser-profiles'/chromium-bot-");
    expect(command).toContain(".browser-profiles'/chromium-screen-");
    expect(container.exec).toHaveBeenCalledOnce();
    expect(container.exec.mock.invocationCallOrder[0]).toBeLessThan(
      container.stop.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    { enabled: true, hosts: [], resumed: false },
    { enabled: true, hosts: ["127.0.0.1"], resumed: true },
    { enabled: true, hosts: ["0.0.0.0", "127.0.0.1"], resumed: false },
    { enabled: false, hosts: ["127.0.0.1"], resumed: false },
    { enabled: false, hosts: ["0.0.0.0"], resumed: false },
    { enabled: false, hosts: [], resumed: true },
  ])("matches publication on stopped container reuse: %j", async ({ enabled, hosts, resumed }) => {
    vi.stubEnv("SANDBOX_CONTROL_VIA_LOOPBACK", String(enabled));
    const { supervisorApp } = await import("./index.js");
    const homePath = path.join(process.env.DATA_DIR!, "homes", "bot");
    const info = {
      Image: "test-image-id",
      Config: {
        User: hostComputerUser(),
        Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
      },
      HostConfig: {
        NetworkMode: computerNetworkNameFor("bot"),
        PortBindings: { "7070/tcp": hosts.map((HostIp) => ({ HostIp, HostPort: "0" })) },
      },
      State: { Running: false },
      NetworkSettings: {
        Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] },
        Networks: { [computerNetworkNameFor("bot")]: { NetworkID: "bot-network" } },
      },
    };
    const existing = {
      id: "existing",
      inspect: vi.fn().mockResolvedValue(info),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const replacement = {
      id: "replacement",
      inspect: vi.fn().mockResolvedValue(info),
      start: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: info.Image }),
    });
    mocks.docker.getContainer.mockReturnValue(existing);
    mocks.docker.listContainers.mockResolvedValue([{ Id: existing.id }]);
    mocks.docker.createContainer.mockResolvedValue(replacement);
    mocks.docker.createNetwork.mockResolvedValue({});
    mocks.docker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: "bot-network" }),
    });

    const response = await supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
      body: JSON.stringify({ botId: "bot", spaceId: "space", homePath }),
    });
    expect(await response.json()).toMatchObject({
      resumed,
      id: resumed ? "existing" : "replacement",
      ...(resumed ? { started: true } : {}),
    });
    expect(response.status).toBe(200);
    if (resumed) {
      expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
      expect(existing.start).toHaveBeenCalledOnce();
      expect(existing.remove).not.toHaveBeenCalled();
      expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    } else {
      expect(existing.remove).toHaveBeenCalledWith({ force: true });
      expect(replacement.start).toHaveBeenCalledOnce();
      const [options] = mocks.docker.createContainer.mock.calls[0]!;
      expect(options.HostConfig.PortBindings["7070/tcp"]).toEqual(
        enabled ? [{ HostIp: "127.0.0.1", HostPort: "0" }] : undefined,
      );
      expect(options.HostConfig.Binds).toEqual([`${homePath}:/home/rakazo`]);
      expect(options.Env).toContainEqual(
        expect.stringMatching(/^RAKAZO_COMPUTER_CONTROL_TOKEN=.+/),
      );
    }
  });
});

describe("provisioning network rollback", () => {
  function fixture() {
    const network = { remove: vi.fn().mockResolvedValue(undefined) };
    const container = {
      id: "new-computer",
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Id: "image" }) });
    mocks.docker.listContainers.mockResolvedValue([]);
    mocks.docker.createNetwork.mockResolvedValue(network);
    mocks.docker.createContainer.mockResolvedValue(container);
    return { network, container };
  }

  async function provision(homePath = path.join(process.env.DATA_DIR!, "homes", "bot")) {
    const { supervisorApp } = await import("./index.js");
    return supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
      body: JSON.stringify({ botId: "bot", spaceId: "space", homePath }),
    });
  }

  it.each(["1.44", "1.45"])(
    "provisions named-volume homes only with subpath support (%s)",
    async (apiVersion) => {
      fixture();
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
      vi.stubEnv("HOSTNAME", "supervisor");
      mocks.docker.version.mockResolvedValue({ ApiVersion: apiVersion });
      mocks.docker.getContainer.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          NetworkSettings: { Networks: { shared: {} } },
          Mounts: [
            {
              Type: "volume",
              Name: "example_appdata",
              Destination: process.env.DATA_DIR,
              Source: "/var/lib/docker/volumes/example_appdata/_data",
            },
          ],
        }),
      });
      const response = await provision();
      if (apiVersion === "1.44") {
        expect(response.status).toBe(500);
        expect(mocks.docker.createContainer).not.toHaveBeenCalled();
        expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
      } else {
        expect(response.status).toBe(200);
        expect(mocks.docker.createContainer).toHaveBeenCalledWith(
          expect.objectContaining({
            User: "1000:1000",
            HostConfig: expect.objectContaining({
              Mounts: [
                expect.objectContaining({
                  Type: "volume",
                  Source: "example_appdata",
                  Target: "/home/rakazo",
                  VolumeOptions: { NoCopy: true, Subpath: "homes/bot" },
                }),
              ],
            }),
          }),
        );
      }
    },
  );

  it("does not allocate a network for an invalid home", async () => {
    fixture();
    expect((await provision("/invalid-home")).status).toBe(500);
    expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
  });

  it("does not allocate a network when home validation fails", async () => {
    fixture();
    mocks.assertHomeWritable.mockRejectedValue(new Error("home is not writable"));
    expect((await provision()).status).toBe(500);
    expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
  });

  it("removes the new network on every failed container creation, then can retry", async () => {
    const { network } = fixture();
    mocks.docker.createContainer.mockRejectedValue(new Error("container creation failed"));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await provision();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "container creation failed" });
      expect(network.remove).toHaveBeenCalledTimes(attempt + 1);
      expect(network.remove).toHaveBeenLastCalledWith();
    }
    const { network: retryNetwork } = fixture();
    expect((await provision()).status).toBe(200);
    expect(retryNetwork.remove).not.toHaveBeenCalled();
  });

  it("removes a failed new container before its new network", async () => {
    const { network, container } = fixture();
    container.start.mockRejectedValue(new Error("container start failed"));
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "container start failed" });
    expect(container.remove).toHaveBeenCalledExactlyOnceWith();
    expect(network.remove).toHaveBeenCalledExactlyOnceWith();
    expect(container.remove.mock.invocationCallOrder[0]).toBeLessThan(
      network.remove.mock.invocationCallOrder[0]!,
    );
  });

  it("preserves the existing computer when its replacement network cannot be allocated", async () => {
    fixture();
    const existing = {
      id: "existing-computer",
      remove: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({
        Image: "old-image",
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        HostConfig: { PortBindings: {} },
        State: { Running: true },
      }),
    };
    mocks.docker.listContainers.mockResolvedValue([{ Id: existing.id }]);
    mocks.docker.getContainer.mockReturnValue(existing);
    mocks.docker.createNetwork.mockRejectedValue(new Error("address pools exhausted"));
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "address pools exhausted" });
    expect(existing.remove).not.toHaveBeenCalled();
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it("does not remove an existing network after failed creation", async () => {
    const { network } = fixture();
    mocks.docker.createNetwork.mockRejectedValue(new Error("network already exists"));
    mocks.docker.createContainer.mockRejectedValue(new Error("container creation failed"));
    expect((await provision()).status).toBe(500);
    expect(network.remove).not.toHaveBeenCalled();
  });

  it("preserves the provision error if Docker refuses cleanup of active resources", async () => {
    const { network, container } = fixture();
    container.start.mockRejectedValue(new Error("start response lost"));
    container.remove.mockRejectedValue(new Error("container is running"));
    network.remove.mockRejectedValue(new Error("network has active endpoints"));
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "start response lost" });
    expect(container.remove).toHaveBeenCalledExactlyOnceWith();
    expect(network.remove).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not allocate or delete the shared internal network", async () => {
    fixture();
    vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
    vi.stubEnv("HOSTNAME", "supervisor");
    mocks.docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        NetworkSettings: { Networks: { shared: {} } },
        Mounts: [],
      }),
    });
    mocks.docker.createContainer.mockRejectedValue(new Error("container creation failed"));
    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "container creation failed" });
    expect(mocks.docker.createContainer).toHaveBeenCalledOnce();
    expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
  });
});

describe("restricted egress rekeying", () => {
  function setupExisting(botNet: string) {
    const homePath = path.join(process.env.DATA_DIR!, "homes", "bot");
    const info = {
      Image: "test-image-id",
      Config: {
        User: hostComputerUser(),
        Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
      },
      HostConfig: { NetworkMode: botNet, PortBindings: {} },
      State: { Running: false },
      NetworkSettings: {
        Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] },
        Networks: { [botNet]: { NetworkID: "bot-network" } },
      },
    };
    const existing = {
      id: "existing",
      inspect: vi.fn().mockResolvedValue(info),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const replacement = {
      id: "replacement",
      inspect: vi.fn().mockResolvedValue(info),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: info.Image }),
    });
    mocks.docker.getContainer.mockReturnValue(existing);
    mocks.docker.listContainers.mockResolvedValue([{ Id: existing.id }]);
    mocks.docker.createContainer.mockResolvedValue(replacement);
    return { homePath, existing, replacement };
  }

  async function provision() {
    const { supervisorApp } = await import("./index.js");
    const homePath = path.join(process.env.DATA_DIR!, "homes", "bot");
    return supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot",
        "x-rakazo-space-id": "space",
      },
      body: JSON.stringify({ botId: "bot", spaceId: "space", homePath }),
    });
  }

  it("replaces a computer whose network lacks the named bridge", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "restricted");
    const botNet = computerNetworkNameFor("bot");
    const { existing } = setupExisting(botNet);
    const network = {
      inspect: vi.fn().mockResolvedValue({ Id: "bot-network", Options: {} }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getNetwork.mockReturnValue(network);
    mocks.docker.createNetwork.mockResolvedValue({});

    const response = await provision();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resumed: false, id: "replacement" });
    expect(existing.remove).toHaveBeenCalledWith({ force: true });
    expect(existing.start).not.toHaveBeenCalled();
  });

  it("resumes a computer whose network has the named bridge", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "restricted");
    const botNet = computerNetworkNameFor("bot");
    const { existing } = setupExisting(botNet);
    const network = {
      inspect: vi.fn().mockResolvedValue({
        Id: "bot-network",
        Options: { "com.docker.network.bridge.name": computerBridgeNameFor("bot") },
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getNetwork.mockReturnValue(network);
    mocks.docker.createNetwork.mockResolvedValue({});

    const response = await provision();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resumed: true, id: "existing" });
    expect(existing.start).toHaveBeenCalledOnce();
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
  });

  it("stops the computer instead of restoring unrestricted egress when rekey removal fails", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "restricted");
    const botNet = computerNetworkNameFor("bot");
    const { existing } = setupExisting(botNet);
    const stop = vi.fn().mockResolvedValue(undefined);
    const kill = vi.fn().mockResolvedValue(undefined);
    Object.assign(existing, { stop, kill });
    const peer = {
      inspect: vi.fn().mockResolvedValue({ Config: { Labels: { "rakazo.botId": "other" } } }),
      stop: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getContainer.mockImplementation((id: string) => (id === "peer" ? peer : existing));
    const network = {
      inspect: vi.fn().mockResolvedValue({
        Id: "bot-network",
        Options: {},
        Containers: { existing: {}, peer: {} },
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockRejectedValue(new Error("network has active endpoints")),
    };
    mocks.docker.getNetwork.mockReturnValue(network);
    mocks.docker.createNetwork.mockRejectedValue(new Error("network already exists"));

    const response = await provision();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("failed to replace unrestricted network"),
    });
    for (const id of ["existing", "peer"]) {
      expect(network.disconnect).toHaveBeenCalledWith({ Container: id, Force: true });
    }
    expect(network.connect).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith({ t: 1 });
    expect(peer.stop).not.toHaveBeenCalled();
    expect(existing.remove).not.toHaveBeenCalled();
    expect(existing.start).not.toHaveBeenCalled();
  });

  it("stops the named computer when endpoint inspection fails during rekey", async () => {
    vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "restricted");
    const botNet = computerNetworkNameFor("bot");
    const { existing } = setupExisting(botNet);
    const info = await existing.inspect();
    let seen = 0;
    existing.inspect.mockImplementation(async () => {
      seen += 1;
      if (seen > 2) throw new Error("inspect failed");
      return info;
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    const kill = vi.fn().mockResolvedValue(undefined);
    Object.assign(existing, { stop, kill });
    const peer = {
      inspect: vi.fn().mockResolvedValue({ Config: { Labels: { "rakazo.botId": "other" } } }),
      stop: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getContainer.mockImplementation((id: string) => (id === "peer" ? peer : existing));
    const network = {
      inspect: vi.fn().mockResolvedValue({
        Id: "bot-network",
        Options: {},
        Containers: { existing: {}, peer: {} },
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockRejectedValue(new Error("network has active endpoints")),
    };
    mocks.docker.getNetwork.mockReturnValue(network);
    mocks.docker.createNetwork.mockRejectedValue(new Error("network already exists"));

    const response = await provision();
    expect(response.status).toBe(500);
    expect(network.connect).not.toHaveBeenCalled();
    expect(mocks.docker.getContainer).toHaveBeenCalledWith(containerNameFor("bot"));
    expect(stop).toHaveBeenCalledWith({ t: 1 });
    expect(peer.stop).not.toHaveBeenCalled();
  });
});

describe("space computer limit enforcement", () => {
  function setupContainerFixture() {
    const network = { remove: vi.fn().mockResolvedValue(undefined) };
    const container = {
      id: "new-container-id",
      start: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({
        State: { Running: true },
        HostConfig: { PortBindings: {} },
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Id: "image" }) });
    mocks.docker.createNetwork.mockResolvedValue(network);
    mocks.docker.createContainer.mockResolvedValue(container);
    return { network, container };
  }

  async function provisionBot(
    botId = "bot-new",
    spaceId = "space-1",
    homePath = path.join(process.env.DATA_DIR!, "homes", botId),
  ) {
    const { supervisorApp } = await import("./index.js");
    return supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": botId,
        "x-rakazo-space-id": spaceId,
      },
      body: JSON.stringify({ botId, spaceId, homePath }),
    });
  }

  it("rejects new container creation with 429 when space container limit is reached", async () => {
    setupContainerFixture();
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "2");

    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        // For findBotContainer check
        if (labels.some((l: string) => l.startsWith("rakazo.botId="))) {
          return [];
        }
        // For countSpaceContainers
        return [
          { Id: "c1", Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space-1" } },
          { Id: "c2", Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space-1" } },
        ];
      },
    );

    const response = await provisionBot("bot-new", "space-1");
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "Computer limit reached for space (max: 2)",
    });
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it("allows new container creation when under space limit", async () => {
    setupContainerFixture();
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "2");

    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        if (labels.some((l: string) => l.startsWith("rakazo.botId="))) {
          return [];
        }
        return [{ Id: "c1", Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space-1" } }];
      },
    );

    const response = await provisionBot("bot-new", "space-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "new-container-id",
    });
    expect(mocks.docker.createContainer).toHaveBeenCalledOnce();
  });

  it("resumes existing container even if space is at limit", async () => {
    setupContainerFixture();
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "1");

    const existing = {
      id: "existing-container",
      inspect: vi.fn().mockResolvedValue({
        Image: "image",
        Config: {
          User: hostComputerUser(process.getuid?.(), process.getgid?.()),
          Labels: {
            "rakazo.managed": "true",
            "rakazo.botId": "bot-existing",
            "rakazo.spaceId": "space-1",
          },
        },
        State: { Running: true },
        HostConfig: {
          NetworkMode: computerNetworkNameFor("bot-existing"),
          PortBindings: {},
          Mounts: [],
        },
        NetworkSettings: { Networks: { [computerNetworkNameFor("bot-existing")]: {} } },
      }),
      start: vi.fn().mockResolvedValue(undefined),
    };

    mocks.docker.getContainer.mockReturnValue(existing);
    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        if (labels.some((l: string) => l === "rakazo.botId=bot-existing")) {
          return [
            {
              Id: existing.id,
              Labels: {
                "rakazo.managed": "true",
                "rakazo.botId": "bot-existing",
                "rakazo.spaceId": "space-1",
              },
            },
          ];
        }
        return [
          { Id: existing.id, Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space-1" } },
        ];
      },
    );

    const response = await provisionBot("bot-existing", "space-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "existing-container",
      resumed: true,
    });
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it("replaces a running container that lost its network attachment", async () => {
    setupContainerFixture();

    // A named network deleted out from under a container (e.g. a failed rekey)
    // leaves HostConfig.NetworkMode set while NetworkSettings has no endpoint —
    // resuming it would report success with zero connectivity, so it must be
    // replaced instead.
    const existing = {
      id: "detached-container",
      inspect: vi.fn().mockResolvedValue({
        Image: "image",
        Config: {
          User: hostComputerUser(process.getuid?.(), process.getgid?.()),
          Labels: {
            "rakazo.managed": "true",
            "rakazo.botId": "bot-detached",
            "rakazo.spaceId": "space-1",
          },
        },
        State: { Running: true },
        HostConfig: {
          NetworkMode: computerNetworkNameFor("bot-detached"),
          PortBindings: {},
          Mounts: [],
        },
        NetworkSettings: { Networks: {} },
      }),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    mocks.docker.getContainer.mockReturnValue(existing);
    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        if (labels.some((l: string) => l === "rakazo.botId=bot-detached")) {
          return [
            {
              Id: existing.id,
              Labels: {
                "rakazo.managed": "true",
                "rakazo.botId": "bot-detached",
                "rakazo.spaceId": "space-1",
              },
            },
          ];
        }
        return [];
      },
    );

    const response = await provisionBot("bot-detached", "space-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "new-container-id",
      resumed: false,
    });
    expect(existing.remove).toHaveBeenCalledWith({ force: true });
    expect(mocks.docker.createContainer).toHaveBeenCalled();
  });

  it("counts legacy workspaceId COMPUTER_IMAGE containers toward the limit", async () => {
    setupContainerFixture();
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "1");

    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        if (labels.some((l: string) => l.startsWith("rakazo.botId="))) {
          return [];
        }
        // Legacy managed computer: COMPUTER_IMAGE + workspaceId, no rakazo.managed.
        return [
          {
            Id: "legacy",
            Image: COMPUTER_IMAGE,
            Labels: { "rakazo.workspaceId": "space-1", "rakazo.botId": "legacy-bot" },
          },
        ];
      },
    );

    const response = await provisionBot("bot-new", "space-1");
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "Computer limit reached for space (max: 1)",
    });
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
  });

  it("serializes concurrent creates for different bots in the same space", async () => {
    const { container } = setupContainerFixture();
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "1");

    let created = 0;
    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        if (labels.some((l: string) => l.startsWith("rakazo.botId="))) {
          return [];
        }
        return Array.from({ length: created }, (_, index) => ({
          Id: `c${index}`,
          Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space-1" },
        }));
      },
    );
    mocks.docker.createContainer.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      created += 1;
      return {
        ...container,
        id: `new-container-${created}`,
      };
    });

    const [first, second] = await Promise.all([
      provisionBot("bot-a", "space-1"),
      provisionBot("bot-b", "space-1"),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 429]);
    expect(mocks.docker.createContainer).toHaveBeenCalledOnce();
    const rejected = first.status === 429 ? first : second;
    expect(await rejected.json()).toEqual({
      error: "Computer limit reached for space (max: 1)",
    });
  });

  it("serializes incompatible replace with a concurrent fresh create at the cap", async () => {
    const { container } = setupContainerFixture();
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "1");

    const present = new Set<string>(["existing-incompatible"]);
    const existing = {
      id: "existing-incompatible",
      inspect: vi.fn().mockResolvedValue({
        Image: "stale-image",
        Config: {
          User: hostComputerUser(process.getuid?.(), process.getgid?.()),
          Labels: {
            "rakazo.managed": "true",
            "rakazo.botId": "bot-existing",
            "rakazo.spaceId": "space-1",
          },
        },
        State: { Running: true },
        HostConfig: {
          NetworkMode: computerNetworkNameFor("bot-existing"),
          PortBindings: {},
          Mounts: [],
        },
      }),
      start: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        present.delete("existing-incompatible");
      }),
    };

    mocks.docker.getContainer.mockImplementation((id: string) =>
      id === existing.id ? existing : container,
    );
    mocks.docker.listContainers.mockImplementation(
      async (opts?: { filters?: { label?: string[] } }) => {
        const labels = opts?.filters?.label ?? [];
        if (labels.some((l: string) => l === "rakazo.botId=bot-existing")) {
          return present.has(existing.id)
            ? [
                {
                  Id: existing.id,
                  Labels: {
                    "rakazo.managed": "true",
                    "rakazo.botId": "bot-existing",
                    "rakazo.spaceId": "space-1",
                  },
                },
              ]
            : [];
        }
        if (labels.some((l: string) => l.startsWith("rakazo.botId="))) {
          return [];
        }
        return [...present].map((Id) => ({
          Id,
          Labels: { "rakazo.managed": "true", "rakazo.spaceId": "space-1" },
        }));
      },
    );
    mocks.docker.createContainer.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const id = `created-${present.size + 1}`;
      present.add(id);
      return { ...container, id };
    });

    const [replaceResponse, createResponse] = await Promise.all([
      provisionBot("bot-existing", "space-1"),
      provisionBot("bot-new", "space-1"),
    ]);
    // With the space lock, the incompatible replace keeps its slot and must succeed;
    // the concurrent fresh create must see the space still at capacity.
    expect(replaceResponse.status).toBe(200);
    expect(createResponse.status).toBe(429);
    expect(mocks.docker.createContainer).toHaveBeenCalledOnce();
    expect(present.size).toBe(1);
    expect(await createResponse.json()).toEqual({
      error: "Computer limit reached for space (max: 1)",
    });
  });
});

describe("screen release status", () => {
  const headers = {
    authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
    "content-type": "application/json",
    "x-rakazo-bot-id": "bot",
    "x-rakazo-space-id": "space",
    "x-rakazo-screen-id": "writer",
  };

  function managedContainer(exec?: ReturnType<typeof vi.fn>) {
    return {
      inspect: vi.fn(async () => ({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        HostConfig: { NetworkMode: computerNetworkNameFor("bot") },
        State: { Running: true },
        NetworkSettings: {
          Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] },
        },
      })),
      exec:
        exec ??
        vi.fn(async () => ({
          start: async () => Readable.from([]),
          inspect: async () => ({ ExitCode: 0 }),
        })),
    };
  }

  it("returns 404 only when the computer is already missing", async () => {
    const { supervisorApp } = await import("./index.js");
    const missing = {
      inspect: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("no such container"), { statusCode: 404 })),
    };
    mocks.docker.getContainer.mockReturnValue(missing);
    const response = await supervisorApp.request("/computers/missing-screen/screen", {
      method: "DELETE",
      headers,
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "computer not found" });
  });

  it("rejects another computer identity without releasing its screen", async () => {
    const { supervisorApp } = await import("./index.js");
    const container = {
      inspect: vi.fn().mockResolvedValue({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "other", "rakazo.spaceId": "other" },
        },
      }),
      exec: vi.fn(),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const response = await supervisorApp.request("/computers/identity-screen/screen", {
      method: "DELETE",
      headers,
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "invalid computer identity" });
    expect(container.exec).not.toHaveBeenCalled();
  });

  it("returns 500 when tearing down a screen leaves the browser running", async () => {
    const { supervisorApp } = await import("./index.js");
    let failStop = false;
    const container = managedContainer(
      vi.fn(async (options: { Cmd?: string[] }) => {
        const command = options.Cmd?.join(" ") ?? "";
        const code = failStop && command.includes("Browser.close") ? 1 : 0;
        return {
          start: async () => Readable.from([]),
          inspect: async () => ({ ExitCode: code }),
        };
      }),
    );
    mocks.docker.getContainer.mockReturnValue(container);
    const opened = await supervisorApp.request("/computers/release-failed/screen-mode", {
      method: "POST",
      headers,
      body: JSON.stringify({ interactive: false, revokeControl: false }),
    });
    expect(opened.status).toBe(200);

    failStop = true;
    const released = await supervisorApp.request("/computers/release-failed/screen", {
      method: "DELETE",
      headers: { ...headers, "x-rakazo-screen-lease-id": "run-1:1" },
    });
    expect(released.status).toBe(500);
    await expect(released.json()).resolves.toEqual({ error: "computer screen failed to stop" });
  });

  it("returns 500 when exec.start 404s after the container was found", async () => {
    const { supervisorApp } = await import("./index.js");
    let failStart = false;
    const container = managedContainer(
      vi.fn(async () => ({
        start: async () => {
          if (failStart) throw Object.assign(new Error("no such exec"), { statusCode: 404 });
          return Readable.from([]);
        },
        inspect: async () => ({ ExitCode: 0 }),
      })),
    );
    mocks.docker.getContainer.mockReturnValue(container);
    const opened = await supervisorApp.request("/computers/exec-start-404/screen-mode", {
      method: "POST",
      headers,
      body: JSON.stringify({ interactive: false, revokeControl: false }),
    });
    expect(opened.status).toBe(200);
    expect(container.inspect).toHaveBeenCalled();

    failStart = true;
    const released = await supervisorApp.request("/computers/exec-start-404/screen", {
      method: "DELETE",
      headers: { ...headers, "x-rakazo-screen-lease-id": "run-1:1" },
    });
    expect(released.status).toBe(500);
    await expect(released.json()).resolves.toEqual({ error: "no such exec" });
  });
});

describe("screen registry across run boundaries", () => {
  it("does not reset the desktop when a screen is requested after the last one is released", async () => {
    const { supervisorApp } = await import("./index.js");
    const commands: string[] = [];
    const container = {
      inspect: vi.fn().mockResolvedValue({
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        HostConfig: { NetworkMode: computerNetworkNameFor("bot") },
        State: { Running: true },
        NetworkSettings: {
          Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] },
        },
      }),
      exec: vi.fn(async ({ Cmd }: { Cmd: string[] }) => {
        commands.push(Cmd.join(" "));
        return { start: async () => Readable.from([]), inspect: async () => ({ ExitCode: 0 }) };
      }),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    const headers = {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
      "x-rakazo-screen-id": "writer",
    };
    const view = () =>
      supervisorApp.request("/computers/registry/screen-mode", {
        method: "POST",
        headers,
        body: JSON.stringify({ interactive: false, revokeControl: false }),
      });
    const resets = () =>
      commands.filter((command) => command.includes("for marker in /tmp/rakazo/browser-profile-*"))
        .length;

    expect((await view()).status).toBe(200);
    expect(resets()).toBe(1);
    const released = await supervisorApp.request("/computers/registry/screen", {
      method: "DELETE",
      headers: { ...headers, "x-rakazo-screen-lease-id": "run-1:1" },
    });
    expect(released.status).toBe(200);
    expect((await view()).status).toBe(200);
    // The first request after a supervisor start resets; a released screen must not.
    expect(resets()).toBe(1);
  });
});

describe("computer network reclaim", () => {
  const botNet = computerNetworkNameFor("bot");
  const homePath = () => path.join(process.env.DATA_DIR!, "homes", "bot");
  const headers = {
    authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
    "x-rakazo-bot-id": "bot",
    "x-rakazo-space-id": "space",
  };

  function botNetwork(attached: string[] = []) {
    return {
      inspect: vi.fn().mockResolvedValue({
        Id: "net-current",
        Containers: Object.fromEntries(attached.map((id) => [id, {}])),
      }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
  }

  function computer() {
    let running = true;
    const container = {
      id: "computer",
      inspect: vi.fn(async () => ({
        Id: "computer-full-id",
        Config: {
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        State: { Running: running },
        // Docker keeps a stopped container's endpoint on its network.
        NetworkSettings: { Networks: { [botNet]: { NetworkID: "net-current" } } },
      })),
      exec: vi.fn(async () => ({
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: 0 }),
      })),
      stop: vi.fn(async () => {
        running = false;
      }),
    };
    mocks.docker.getContainer.mockReturnValue(container);
    networkUsers(["computer-full-id"]);
    return container;
  }

  // Containers listed by network, stopped ones included; webIds answers the
  // Compose web proxy lookup.
  function networkUsers(ids: string[], webIds: string[] = []) {
    mocks.docker.listContainers.mockImplementation(
      async ({ filters }: { filters: { network?: string[] } }) =>
        (filters.network ? ids : webIds).map((Id) => ({ Id })),
    );
  }

  async function stop() {
    const { supervisorApp } = await import("./index.js");
    return supervisorApp.request("/computers/computer/stop", { method: "POST", headers });
  }

  describe("on stop", () => {
    it("disconnects the stopped computer, then gives its network back to Docker", async () => {
      const container = computer();
      const network = botNetwork();
      mocks.docker.getNetwork.mockReturnValue(network);

      expect((await stop()).status).toBe(200);
      expect(mocks.docker.getNetwork).toHaveBeenCalledWith(botNet);
      expect(network.disconnect).toHaveBeenCalledExactlyOnceWith({
        Container: "computer-full-id",
      });
      expect(network.remove).toHaveBeenCalledExactlyOnceWith();
      expect(container.stop.mock.invocationCallOrder[0]).toBeLessThan(
        network.disconnect.mock.invocationCallOrder[0]!,
      );
      expect(network.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
        network.remove.mock.invocationCallOrder[0]!,
      );
    });

    it("reclaims a network created before networks carried an owner label", async () => {
      computer();
      const network = botNetwork();
      // Ownership comes from the computer's identity, not from network labels.
      network.inspect.mockResolvedValue({ Id: "net-legacy", Labels: {}, Containers: {} });
      mocks.docker.getNetwork.mockReturnValue(network);

      expect((await stop()).status).toBe(200);
      expect(network.remove).toHaveBeenCalledOnce();
    });

    it("disconnects the Compose screen peers of an isolated computer network", async () => {
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
      vi.stubEnv("HOSTNAME", "supervisor");
      const container = computer();
      const supervisor = {
        inspect: vi.fn().mockResolvedValue({
          Id: "supervisor-id",
          Config: { Labels: { "com.docker.compose.project": "example" } },
        }),
      };
      mocks.docker.getContainer.mockImplementation((id: string) =>
        id === "supervisor" ? supervisor : container,
      );
      networkUsers(["supervisor-id", "computer-full-id", "web-id"], ["web-id"]);
      // The web proxy is stopped, so network inspect lists only the supervisor. Left
      // attached, it could not start again once the network is gone.
      const network = botNetwork(["supervisor-id"]);
      mocks.docker.getNetwork.mockReturnValue(network);

      expect((await stop()).status).toBe(200);
      expect(mocks.docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { network: [botNet] },
      });
      expect(mocks.docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: {
          label: ["com.docker.compose.project=example", "com.docker.compose.service=web"],
        },
      });
      expect(network.disconnect.mock.calls).toEqual([
        [{ Container: "computer-full-id" }],
        [{ Container: "supervisor-id" }],
        [{ Container: "web-id" }],
      ]);
      expect(network.remove).toHaveBeenCalledOnce();
    });

    it("keeps the network when a screen peer cannot be disconnected from it", async () => {
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
      vi.stubEnv("HOSTNAME", "supervisor");
      const container = computer();
      const supervisor = {
        inspect: vi.fn().mockResolvedValue({ Id: "supervisor-id", Config: { Labels: {} } }),
      };
      mocks.docker.getContainer.mockImplementation((id: string) =>
        id === "supervisor" ? supervisor : container,
      );
      networkUsers(["computer-full-id", "supervisor-id"]);
      const network = botNetwork();
      network.disconnect.mockImplementation(async ({ Container }: { Container: string }) => {
        if (Container === "supervisor-id") throw new Error("disconnect failed");
      });
      mocks.docker.getNetwork.mockReturnValue(network);

      expect((await stop()).status).toBe(200);
      expect(network.remove).not.toHaveBeenCalled();
    });

    it.each([
      ["running", ["another-container"]],
      ["stopped", []],
    ])(
      "keeps a network that a %s container other than a screen peer uses",
      async (_state, running) => {
        computer();
        networkUsers(["computer-full-id", "another-container"]);
        const network = botNetwork(running);
        mocks.docker.getNetwork.mockReturnValue(network);

        expect((await stop()).status).toBe(200);
        expect(network.disconnect).not.toHaveBeenCalled();
        expect(network.remove).not.toHaveBeenCalled();
      },
    );

    it("keeps the network when the computer cannot be disconnected from it", async () => {
      computer();
      const network = botNetwork();
      network.disconnect.mockRejectedValue(new Error("disconnect failed"));
      mocks.docker.getNetwork.mockReturnValue(network);

      expect((await stop()).status).toBe(200);
      expect(network.remove).not.toHaveBeenCalled();
    });

    it.each([
      ["logs", new Error("permission denied"), true],
      ["does not log", new Error("network example has active endpoints"), false],
    ])("%s a failed removal without failing the stop: %s", async (_case, error, logged) => {
      computer();
      const network = botNetwork();
      network.remove.mockRejectedValue(error);
      mocks.docker.getNetwork.mockReturnValue(network);
      const { getLogger } = await import("@rakazo/logging");
      const logError = vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);

      expect((await stop()).status).toBe(200);
      if (logged) {
        expect(logError).toHaveBeenCalledWith("computer network reclaim failed", error);
      } else {
        expect(logError).not.toHaveBeenCalled();
      }
    });

    it("does not touch the shared internal network", async () => {
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
      computer();
      mocks.docker.getNetwork.mockReturnValue(botNetwork());

      expect((await stop()).status).toBe(200);
      expect(mocks.docker.getNetwork).not.toHaveBeenCalled();
    });

    it("does not reclaim the network of a computer that failed to stop", async () => {
      const container = computer();
      container.stop.mockRejectedValue(new Error("stop failed"));
      mocks.docker.getNetwork.mockReturnValue(botNetwork());

      expect((await stop()).status).toBe(500);
      expect(mocks.docker.getNetwork).not.toHaveBeenCalled();
    });

    it("waits for an in-flight provision of the same bot before reclaiming", async () => {
      const { supervisorApp } = await import("./index.js");
      computer();
      const network = botNetwork();
      mocks.docker.getNetwork.mockReturnValue(network);
      mocks.docker.getImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: "image" }),
      });
      mocks.docker.listContainers.mockResolvedValue([]);
      mocks.docker.createNetwork.mockResolvedValue(network);
      let attach!: () => void;
      const attached = new Promise<void>((resolve) => {
        attach = resolve;
      });
      mocks.docker.createContainer.mockImplementation(async () => {
        await attached;
        return { id: "replacement", start: vi.fn().mockResolvedValue(undefined) };
      });
      const provision = supervisorApp.request("/computers", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ botId: "bot", spaceId: "space", homePath: homePath() }),
      });
      await vi.waitFor(() => expect(mocks.docker.createContainer).toHaveBeenCalled());

      const stopped = stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(network.inspect).not.toHaveBeenCalled();
      attach();
      expect((await provision).status).toBe(200);
      expect((await stopped).status).toBe(200);
      expect(network.inspect).toHaveBeenCalled();
    });
  });

  it("disconnects a stopped screen peer when the computer is deleted", async () => {
    vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
    vi.stubEnv("HOSTNAME", "supervisor");
    const container = Object.assign(computer(), { remove: vi.fn().mockResolvedValue(undefined) });
    const supervisor = {
      inspect: vi.fn().mockResolvedValue({
        Id: "supervisor-id",
        Config: { Labels: { "com.docker.compose.project": "example" } },
      }),
    };
    mocks.docker.getContainer.mockImplementation((id: string) =>
      id === "supervisor" ? supervisor : container,
    );
    networkUsers(["supervisor-id", "web-id"], ["web-id"]);
    // The web proxy is stopped, so network inspect lists only the supervisor.
    const network = botNetwork(["supervisor-id"]);
    mocks.docker.getNetwork.mockImplementation((name: string) =>
      name === botNet
        ? network
        : { inspect: vi.fn().mockRejectedValue(new Error("no such network")) },
    );
    const { supervisorApp } = await import("./index.js");

    const response = await supervisorApp.request("/computers/computer", {
      method: "DELETE",
      headers,
    });
    expect(response.status).toBe(200);
    expect(container.remove).toHaveBeenCalledWith({ force: true });
    expect(network.disconnect.mock.calls).toEqual([
      [{ Container: "supervisor-id" }],
      [{ Container: "web-id" }],
    ]);
    expect(network.remove).toHaveBeenCalledOnce();
  });

  describe("on startup", () => {
    async function reclaim() {
      const { reclaimIdleComputerNetworks } = await import("./index.js");
      return reclaimIdleComputerNetworks();
    }

    function ownerLabel() {
      return computerNetworkOwnerFor(process.env.DATA_DIR!, undefined);
    }

    it("removes only its own labeled networks that no container uses", async () => {
      const networks: Record<string, ReturnType<typeof botNetwork>> = {
        [computerNetworkNameFor("orphan")]: botNetwork(),
        [computerNetworkNameFor("stopped")]: botNetwork(),
        [computerNetworkNameFor("renamed")]: botNetwork(),
      };
      mocks.docker.listNetworks.mockResolvedValue([
        { Name: computerNetworkNameFor("orphan"), Labels: { "rakazo.botId": "orphan" } },
        { Name: computerNetworkNameFor("stopped"), Labels: { "rakazo.botId": "stopped" } },
        // The bot label must name the network, since it picks the lock.
        { Name: computerNetworkNameFor("renamed"), Labels: { "rakazo.botId": "other" } },
      ]);
      mocks.docker.getNetwork.mockImplementation((name: string) => networks[name]);
      mocks.docker.listContainers.mockImplementation(
        async ({ filters }: { filters: { network: string[] } }) =>
          // A stopped computer still uses its network, though network inspect omits it.
          filters.network[0] === computerNetworkNameFor("stopped") ? [{ Id: "stopped-id" }] : [],
      );

      await reclaim();
      expect(mocks.docker.listNetworks).toHaveBeenCalledWith({
        filters: { label: [`rakazo.computerOwner=${ownerLabel()}`] },
      });
      expect(mocks.docker.listContainers).toHaveBeenCalledWith({
        all: true,
        filters: { network: [computerNetworkNameFor("orphan")] },
      });
      expect(networks[computerNetworkNameFor("orphan")]!.remove).toHaveBeenCalledOnce();
      expect(networks[computerNetworkNameFor("stopped")]!.remove).not.toHaveBeenCalled();
      expect(networks[computerNetworkNameFor("stopped")]!.disconnect).not.toHaveBeenCalled();
      expect(mocks.docker.getNetwork).not.toHaveBeenCalledWith(computerNetworkNameFor("renamed"));
    });

    it("disconnects the Compose screen peers from an orphaned isolated network", async () => {
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
      vi.stubEnv("HOSTNAME", "supervisor");
      mocks.docker.getContainer.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          Id: "supervisor-id",
          Config: { Labels: { "com.docker.compose.project": "example" } },
          Mounts: [],
        }),
      });
      const network = botNetwork();
      mocks.docker.getNetwork.mockReturnValue(network);
      mocks.docker.listNetworks.mockResolvedValue([
        { Name: botNet, Labels: { "rakazo.botId": "bot" } },
      ]);
      mocks.docker.listContainers.mockImplementation(
        async ({ filters }: { filters: { network?: string[] } }) =>
          filters.network ? [{ Id: "supervisor-id" }, { Id: "web-id" }] : [{ Id: "web-id" }],
      );

      await reclaim();
      expect(network.disconnect.mock.calls).toEqual([
        [{ Container: "supervisor-id" }],
        [{ Container: "web-id" }],
      ]);
      expect(network.remove).toHaveBeenCalledOnce();
    });

    it("does nothing in the shared internal topology", async () => {
      vi.stubEnv("SANDBOX_SCREEN_NETWORK", "internal");
      await reclaim();
      expect(mocks.docker.listNetworks).not.toHaveBeenCalled();
      expect(mocks.docker.getNetwork).not.toHaveBeenCalled();
    });
  });

  describe("resuming a stopped computer", () => {
    function stoppedComputer(networks: Record<string, { NetworkID: string }>) {
      const info = {
        Image: "image",
        Config: {
          User: hostComputerUser(),
          Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
        },
        HostConfig: { NetworkMode: botNet, PortBindings: {} },
        State: { Running: false },
        NetworkSettings: { Networks: networks },
      };
      const existing = {
        id: "existing",
        inspect: vi.fn().mockResolvedValue(info),
        start: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      const replacement = { id: "replacement", start: vi.fn().mockResolvedValue(undefined) };
      mocks.docker.getImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ Id: "image" }),
      });
      mocks.docker.getContainer.mockReturnValue(existing);
      mocks.docker.listContainers.mockResolvedValue([{ Id: existing.id }]);
      mocks.docker.createNetwork.mockResolvedValue({ remove: vi.fn() });
      mocks.docker.createContainer.mockResolvedValue(replacement);
      return { existing, replacement };
    }

    async function provision() {
      const { supervisorApp } = await import("./index.js");
      return supervisorApp.request("/computers", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ botId: "bot", spaceId: "space", homePath: homePath() }),
      });
    }

    function expectReconnected(
      existing: { start: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> },
      network: ReturnType<typeof botNetwork>,
    ) {
      expect(network.connect).toHaveBeenCalledExactlyOnceWith({ Container: "existing" });
      expect(existing.start).toHaveBeenCalledOnce();
      expect(network.connect.mock.invocationCallOrder[0]).toBeLessThan(
        existing.start.mock.invocationCallOrder[0]!,
      );
      expect(existing.remove).not.toHaveBeenCalled();
      expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    }

    it.each(["open", "restricted"])(
      "recreates a reclaimed network and reconnects the same container (%s egress)",
      async (egress) => {
        vi.stubEnv("SANDBOX_COMPUTER_EGRESS", egress);
        const { existing } = stoppedComputer({});
        const network = botNetwork();
        network.inspect.mockRejectedValue(
          Object.assign(new Error("no such network"), { statusCode: 404 }),
        );
        mocks.docker.getNetwork.mockReturnValue(network);

        const response = await provision();
        expect(await response.json()).toMatchObject({ id: "existing", resumed: true });
        expect(mocks.docker.createNetwork).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            Name: botNet,
            Labels: {
              "rakazo.computerOwner": computerNetworkOwnerFor(process.env.DATA_DIR!, undefined),
              "rakazo.botId": "bot",
            },
            ...(egress === "restricted"
              ? { Options: { "com.docker.network.bridge.name": computerBridgeNameFor("bot") } }
              : {}),
          }),
        );
        expect(network.disconnect).not.toHaveBeenCalled();
        expectReconnected(existing, network);
      },
    );

    it.each([
      ["removed", Object.assign(new Error("no such network"), { statusCode: 404 })],
      ["recreated", undefined],
    ])("moves a stale endpoint onto the network when it was %s under it", async (_case, error) => {
      const { existing } = stoppedComputer({ [botNet]: { NetworkID: "net-old" } });
      const network = botNetwork();
      if (error) network.inspect.mockRejectedValue(error);
      mocks.docker.getNetwork.mockReturnValue(network);

      const response = await provision();
      expect(await response.json()).toMatchObject({ id: "existing", resumed: true });
      expect(network.disconnect).toHaveBeenCalledWith({ Container: "existing", Force: true });
      expect(network.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
        network.connect.mock.invocationCallOrder[0]!,
      );
      expectReconnected(existing, network);
    });

    it("restarts it without reconnecting while its endpoint is on the current network", async () => {
      const { existing } = stoppedComputer({ [botNet]: { NetworkID: "net-current" } });
      const network = botNetwork();
      mocks.docker.getNetwork.mockReturnValue(network);

      const response = await provision();
      expect(await response.json()).toMatchObject({ id: "existing", resumed: true });
      expect(existing.start).toHaveBeenCalledOnce();
      expect(network.connect).not.toHaveBeenCalled();
      expect(mocks.docker.createNetwork).not.toHaveBeenCalled();
    });

    it.each([
      ["a leftover endpoint", new Error("endpoint with name rakazo-bot-bot already exists")],
      ["a missing container", Object.assign(new Error("no such container"), { statusCode: 404 })],
    ])(
      "replaces it, never starting it unattached, when Docker refuses to attach it: %s",
      async (_case, error) => {
        const { existing, replacement } = stoppedComputer({});
        const network = botNetwork();
        network.connect.mockRejectedValue(error);
        mocks.docker.getNetwork.mockReturnValue(network);

        const response = await provision();
        expect(await response.json()).toMatchObject({ id: "replacement", resumed: false });
        expect(existing.start).not.toHaveBeenCalled();
        expect(existing.remove).toHaveBeenCalledWith({ force: true });
        expect(replacement.start).toHaveBeenCalledOnce();
      },
    );

    it("keeps it when its network cannot be recreated", async () => {
      const { existing } = stoppedComputer({});
      mocks.docker.getNetwork.mockReturnValue(botNetwork());
      mocks.docker.createNetwork.mockRejectedValue(new Error("address pools exhausted"));

      const response = await provision();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "address pools exhausted" });
      expect(existing.start).not.toHaveBeenCalled();
      expect(existing.remove).not.toHaveBeenCalled();
    });

    it("keeps it through a transient failure that a retry would get past", async () => {
      const { existing } = stoppedComputer({});
      mocks.docker.getNetwork.mockReturnValue(botNetwork());
      // Only the first create fails, so falling through to the replace path's
      // own create would succeed and remove this container.
      mocks.docker.createNetwork
        .mockRejectedValueOnce(new Error("daemon busy"))
        .mockResolvedValue({ remove: vi.fn() });

      const response = await provision();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "daemon busy" });
      expect(mocks.docker.createNetwork).toHaveBeenCalledOnce();
      expect(existing.start).not.toHaveBeenCalled();
      expect(existing.remove).not.toHaveBeenCalled();
      expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    });

    it.each([
      [
        "fails transiently and keeps it",
        Object.assign(new Error("daemon busy"), { statusCode: 500 }),
        false,
      ],
      [
        "is already gone and reconnects it",
        new Error("container is not connected to the network"),
        true,
      ],
    ])("when clearing a stale endpoint %s", async (_case, error, resumed) => {
      const { existing } = stoppedComputer({ [botNet]: { NetworkID: "net-old" } });
      const network = botNetwork();
      network.disconnect.mockRejectedValue(error);
      mocks.docker.getNetwork.mockReturnValue(network);

      const response = await provision();
      if (resumed) {
        expect(await response.json()).toMatchObject({ id: "existing", resumed: true });
        expect(network.connect).toHaveBeenCalledOnce();
      } else {
        expect(response.status).toBe(500);
        expect(network.connect).not.toHaveBeenCalled();
        expect(existing.start).not.toHaveBeenCalled();
      }
      expect(existing.remove).not.toHaveBeenCalled();
      expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    });

    it("keeps it when attaching it fails transiently", async () => {
      const { existing } = stoppedComputer({});
      const network = botNetwork();
      network.connect.mockRejectedValue(
        Object.assign(new Error("daemon busy"), { statusCode: 500 }),
      );
      mocks.docker.getNetwork.mockReturnValue(network);

      const response = await provision();
      expect(response.status).toBe(500);
      expect(existing.start).not.toHaveBeenCalled();
      expect(existing.remove).not.toHaveBeenCalled();
      expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    });

    it("surfaces a transient network inspect failure instead of replacing it", async () => {
      const { existing } = stoppedComputer({ [botNet]: { NetworkID: "net-current" } });
      const network = botNetwork();
      network.inspect.mockRejectedValue(new Error("daemon unavailable"));
      mocks.docker.getNetwork.mockReturnValue(network);

      expect((await provision()).status).toBe(500);
      expect(existing.start).not.toHaveBeenCalled();
      expect(existing.remove).not.toHaveBeenCalled();
    });
  });
});
