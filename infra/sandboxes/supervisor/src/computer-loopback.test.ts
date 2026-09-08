import type * as NodeFsPromises from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computerNetworkNameFor, hostComputerUser } from "./computer-spec.js";

const mocks = vi.hoisted(() => ({
  docker: {
    getImage: vi.fn(),
    getContainer: vi.fn(),
    listContainers: vi.fn(),
    createContainer: vi.fn(),
    createNetwork: vi.fn(),
  },
  assertHomeWritable: vi.fn(),
}));
vi.mock("dockerode", () => ({
  default: class {
    getImage = mocks.docker.getImage;
    getContainer = mocks.docker.getContainer;
    listContainers = mocks.docker.listContainers;
    createContainer = mocks.docker.createContainer;
    createNetwork = mocks.docker.createNetwork;
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
      NetworkSettings: { Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: screenPort }] } },
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
