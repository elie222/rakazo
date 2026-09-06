import http from "node:http";
import path from "node:path";
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
  ...(await importOriginal<typeof import("node:fs/promises")>()),
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
