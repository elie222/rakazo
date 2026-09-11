import type * as NodeFsPromises from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_IMAGE, computerNetworkNameFor, hostComputerUser } from "./computer-spec.js";

const mocks = vi.hoisted(() => ({
  docker: {
    version: vi.fn(),
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
    version = mocks.docker.version;
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
