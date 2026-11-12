import type { AdapterContext } from "@rakazo/adapter-kit";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import { tailnetNodeAttributes } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { FakeTailnetNodeHost, TailscaleApiEmulator } from "./tailnet-emulator.js";
import { TailscaleApi, TailscaleNetwork } from "./tailscale-network.js";

const SECRET = "tskey-client-kTEST-secretvalue";

function context(): AdapterContext {
  return {
    operationId: "op",
    traceId: "op",
    spaceId: "space1",
    userId: "user1",
    botId: "bot1",
    signal: new AbortController().signal,
  };
}

function setup(
  options: { scopes?: string[]; tags?: string[]; tag?: string; secret?: string } = {},
) {
  let now = Date.parse("2026-11-12T00:00:00Z");
  const emulator = new TailscaleApiEmulator(() => now);
  emulator.addClient("client1", {
    secret: SECRET,
    scopes: options.scopes ?? ["auth_keys", "devices:posture_attributes"],
    tags: options.tags ?? ["tag:rakazo"],
  });
  const api = new TailscaleApi(
    {
      clientId: "client1",
      clientSecret: options.secret ?? SECRET,
      tag: options.tag ?? "tag:rakazo",
    },
    { fetch: emulator.fetch, now: () => now },
  );
  const nodes = new FakeTailnetNodeHost(emulator);
  const network = new TailscaleNetwork(api, nodes);
  return { emulator, nodes, network, advance: (ms: number) => (now += ms) };
}

const NODE = {
  nodeId: "user1:bot1",
  hostname: "rakazo-helper-bot1",
  attributes: tailnetNodeAttributes({ spaceId: "space1", botId: "bot1", userId: "user1" }),
};

async function rejection(promise: Promise<unknown>): Promise<PrivateNetworkError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PrivateNetworkError);
  return error as PrivateNetworkError;
}

describe("TailscaleNetwork", () => {
  it("joins each bot as an ephemeral, pre-approved node with its tag and attributes", async () => {
    const { emulator, network } = setup();
    await network.join(NODE, context());
    expect(emulator.devices.get(NODE.nodeId)).toEqual({
      nodeId: NODE.nodeId,
      hostname: NODE.hostname,
      tags: ["tag:rakazo"],
      attributes: {
        "custom:rakazoSpace": "space1",
        "custom:rakazoBot": "bot1",
        "custom:rakazoUser": "user1",
      },
      ephemeral: true,
    });
    const [key] = emulator.keys.values();
    expect(key).toMatchObject({ reusable: false, preauthorized: true, used: true });
  });

  it("starts one node for concurrent joins and none for a node already up", async () => {
    const { emulator, network } = setup();
    await Promise.all([network.join(NODE, context()), network.join(NODE, context())]);
    await network.join(NODE, context());
    expect(emulator.keys.size).toBe(1);
  });

  it("reuses the access token until it nears expiry", async () => {
    const { emulator, network, advance } = setup();
    await network.join(NODE, context());
    await network.join({ ...NODE, nodeId: "user1:bot2" }, context());
    const tokenRequests = () =>
      emulator.requests.filter((request) => request.path === "/api/v2/oauth/token").length;
    expect(tokenRequests()).toBe(1);
    advance(3600_000 - 30_000);
    await network.join({ ...NODE, nodeId: "user1:bot3" }, context());
    expect(tokenRequests()).toBe(2);
  });

  it("revokes the key when the node fails to start", async () => {
    const { emulator, nodes, network } = setup();
    nodes.start = async () => {
      throw new PrivateNetworkError("unavailable", "sidecar down");
    };
    await rejection(network.join(NODE, context()));
    expect(emulator.keys.size).toBe(0);
  });

  it("dials tailnet services and refuses anything off the tailnet", async () => {
    const { nodes, network } = setup();
    nodes.serve({ host: "nas.tail1234.ts.net", port: 7 }, (socket, from) => {
      socket.once("data", (chunk) => socket.end(`${from.attributes["custom:rakazoBot"]}:${chunk}`));
    });
    await network.join(NODE, context());
    const socket = await network.dial(
      NODE.nodeId,
      { host: "nas.tail1234.ts.net", port: 7 },
      context(),
    );
    socket.end("ping");
    let reply = "";
    for await (const chunk of socket) reply += chunk;
    expect(reply).toBe("bot1:ping");

    const offTailnet = await rejection(
      network.dial(NODE.nodeId, { host: "example.com", port: 443 }, context()),
    );
    expect(offTailnet.code).toBe("destination");
  });

  it("deletes the ephemeral node and drops its connections when it leaves", async () => {
    const { emulator, nodes, network } = setup();
    nodes.serve({ host: "100.64.0.9", port: 22 }, () => {});
    await network.join(NODE, context());
    const socket = await network.dial(NODE.nodeId, { host: "100.64.0.9", port: 22 }, context());
    await network.leave(NODE.nodeId, context());
    expect(socket.destroyed).toBe(true);
    expect(emulator.devices.has(NODE.nodeId)).toBe(false);
    const after = await rejection(
      network.dial(NODE.nodeId, { host: "100.64.0.9", port: 22 }, context()),
    );
    expect(after.code).toBe("unavailable");
  });

  describe("verify", () => {
    it("passes for a correctly scoped client and leaves no key behind", async () => {
      const { emulator, network } = setup();
      await network.verify(context());
      expect(emulator.keys.size).toBe(0);
      expect(emulator.devices.size).toBe(0);
    });

    it("reports wrong credentials without echoing the secret", async () => {
      const { network } = setup({ secret: "tskey-client-wrong" });
      const error = await rejection(network.verify(context()));
      expect(error.code).toBe("credentials");
      expect(error.message).not.toContain("tskey-client");
    });

    it.each([
      [{ scopes: ["devices:core"] }, "missing scope"],
      [{ scopes: ["auth_keys"] }, "devices:posture_attributes"],
      [{ tag: "tag:other" }, "not permitted"],
    ])("explains a client that can't mint bot keys (%o)", async (options, detail) => {
      const { network } = setup(options);
      const error = await rejection(network.verify(context()));
      expect(error.code).toBe("permission");
      expect(error.message).toContain(detail);
    });

    it("reports an outage as retryable", async () => {
      const { emulator, network } = setup();
      emulator.failWith = 503;
      expect((await rejection(network.verify(context()))).code).toBe("unavailable");
    });
  });
});
