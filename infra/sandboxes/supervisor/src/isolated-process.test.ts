import { Duplex } from "node:stream";
import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "./isolated-process.js";
import {
  assertHarnessDaemon,
  credentialVolumeName,
  IsolatedProcessManager,
  isolatedProcessContainerOptions,
  isolatedProcessRequest,
  isolatedProcessRoutes,
  nativeStateCleanupRequest,
  processFrameDecoder,
  sessionFamilyName,
  sessionVolumeName,
} from "./isolated-process.js";

const identity: ProcessIdentity = {
  computerId: "computer",
  computerBotId: "team",
  spaceId: "space",
  botId: "bot",
  userId: "user",
  runId: "run",
};
const request = { isolation: "primary-harness" as const, argv: ["node", "--version"] };
const scope = {
  threadId: "thread",
  profileId: "profile",
  profileRevision: 1,
  accountId: "account",
  epoch: "epoch",
};

function frame(type: number, payload: Buffer | string) {
  const data = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

function fakeDocker() {
  const inputs: string[] = [];
  const inputEnd = vi.fn();
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      inputs.push(chunk.toString());
      callback();
    },
    final(callback) {
      inputEnd();
      callback();
    },
  });
  let exit!: (result: { StatusCode: number }) => void;
  const completed = new Promise<{ StatusCode: number }>((resolve) => {
    exit = resolve;
  });
  const container = {
    attach: vi.fn(async () => stream),
    start: vi.fn(async () => undefined),
    wait: vi.fn(() => completed),
    remove: vi.fn(async () => undefined),
  };
  const network = { id: "network", remove: vi.fn(async () => undefined) };
  const volumes = new Map<string, { Name: string; Labels: Record<string, string> }>();
  const removeVolume = vi.fn(async (name: string) => {
    volumes.delete(name);
  });
  const docker = {
    info: vi.fn(async () => ({ OSType: "linux", OperatingSystem: "Debian", SecurityOptions: [] })),
    listContainers: vi.fn(async () => []),
    listNetworks: vi.fn(async () => []),
    createNetwork: vi.fn(async () => network),
    createContainer: vi.fn(async (_options: Docker.ContainerCreateOptions) => container),
    getVolume: vi.fn((name: string) => ({
      inspect: vi.fn(async () => {
        const v = volumes.get(name);
        if (!v) throw { statusCode: 404 };
        return v;
      }),
      remove: () => removeVolume(name),
    })),
    createVolume: vi.fn(async (value: { Name: string; Labels: Record<string, string> }) => {
      volumes.set(value.Name, value);
      return value;
    }),
    listVolumes: vi.fn(async () => ({ Volumes: [...volumes.values()] })),
  };
  return {
    docker,
    container,
    stream,
    network,
    inputs,
    inputEnd,
    exit,
    volumes,
    removeVolume,
    manager: new IsolatedProcessManager(docker as unknown as Docker, "restricted", "installation"),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("isolated runtime security", () => {
  it("accepts only documented bounded Claude model role values and one auth scheme", () => {
    for (const key of [
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) {
      expect(
        isolatedProcessRequest.safeParse({
          ...request,
          env: {
            ANTHROPIC_AUTH_TOKEN: "fake-token",
            [key]: "provider/model[1m]",
          },
        }).success,
      ).toBe(true);
      for (const value of [" ", "a".repeat(201), "model\nvalue", "\u007f", "😀".repeat(101)]) {
        expect(
          isolatedProcessRequest.safeParse({ ...request, env: { [key]: value } }).success,
        ).toBe(false);
      }
    }
    expect(
      isolatedProcessRequest.safeParse({
        ...request,
        env: {
          ANTHROPIC_API_KEY: "fake-key",
          ANTHROPIC_AUTH_TOKEN: "fake-token",
        },
      }).success,
    ).toBe(false);
    expect(
      isolatedProcessRequest.safeParse({
        ...request,
        env: {
          ANTHROPIC_DEFAULT_UNKNOWN_MODEL: "unknown",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects runtime config/environment injection and untrusted workspaces", () => {
    for (const key of [
      "HOME",
      "PATH",
      "NODE_OPTIONS",
      "PYTHONPATH",
      "LD_PRELOAD",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
    ]) {
      expect(
        isolatedProcessRequest.safeParse({ ...request, env: { [key]: "hostile" } }).success,
      ).toBe(false);
    }
    expect(isolatedProcessRequest.safeParse({ ...request, cwd: "/home/rakazo/repo" }).success).toBe(
      false,
    );
    expect(
      isolatedProcessRequest.safeParse({ ...request, env: { ANTHROPIC_API_KEY: "fake-key" } })
        .success,
    ).toBe(true);
  });

  it("has a separate PID/network namespace and no team/host mounts or inherited environment", () => {
    const spec = isolatedProcessContainerOptions("id", identity, request, "private-network");
    expect(spec.User).toBe("10001:10001");
    expect(spec.WorkingDir).toBe("/home/harness");
    expect(spec.Entrypoint).toEqual(["/usr/bin/timeout"]);
    expect(spec.Cmd).toContain("/opt/rakazo-harness/launch.py");
    expect(spec.Cmd).toContain("--kill-after=5s");
    expect(spec.HostConfig).toMatchObject({
      NetworkMode: "private-network",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Init: true,
    });
    expect(spec.HostConfig?.Mounts).toEqual([]);
    expect(spec.HostConfig?.Binds).toBeUndefined();
    expect(spec.HostConfig?.PidMode).toBeUndefined();
    expect(spec.HostConfig?.Privileged).toBeUndefined();
    expect(spec.HostConfig?.Tmpfs?.["/home/harness"]).toContain("uid=10001");
    expect(spec.HostConfig?.LogConfig?.Type).toBe("none");
    const secretSpec = isolatedProcessContainerOptions(
      "id",
      identity,
      { ...request, env: { OPENAI_API_KEY: "fake-sensitive-value" } },
      "network",
    );
    expect(JSON.stringify(secretSpec)).not.toContain("fake-sensitive-value");
    expect(secretSpec.Env).toBeUndefined();
  });

  it("uses only a scoped session volume and rotates scope on identity or epoch changes", () => {
    const base = sessionVolumeName("installation", identity, scope);
    expect(sessionVolumeName("installation", { ...identity, runId: "next-run" }, scope)).toBe(base);
    for (const changed of [
      { threadId: "other" },
      { profileId: "other" },
      { profileRevision: 2 },
      { accountId: "other" },
      { epoch: "other" },
    ]) {
      expect(sessionVolumeName("installation", identity, { ...scope, ...changed })).not.toBe(base);
    }
    for (const changed of [{ botId: "other" }, { spaceId: "other" }, { userId: "other" }]) {
      expect(sessionVolumeName("installation", { ...identity, ...changed }, scope)).not.toBe(base);
    }
    const spec = isolatedProcessContainerOptions(
      "id",
      identity,
      { ...request, sessionScope: scope },
      "network",
      base,
    );
    expect(spec.HostConfig?.Mounts).toEqual([
      { Type: "volume", Source: base, Target: "/sessions", ReadOnly: false },
    ]);
  });

  it.each([
    { OSType: "windows" },
    { OSType: "linux", OperatingSystem: "Docker Desktop" },
    { OSType: "linux", SecurityOptions: ["name=rootless"] },
    {},
  ])("rejects unsupported daemon %j", (info) => {
    expect(() => assertHarnessDaemon(info)).toThrow(/rootful Linux/);
  });

  it("fails closed without operator-attested restricted egress", async () => {
    const fake = fakeDocker();
    await expect(
      fake.manager.start(identity, request, new AbortController().signal),
    ).rejects.toThrow(/verified restricted/);
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const open = new IsolatedProcessManager(
      fake.docker as unknown as Docker,
      "open",
      "installation",
    );
    await expect(open.start(identity, request, new AbortController().signal)).rejects.toThrow(
      /verified restricted/,
    );
    expect(fake.docker.createContainer).not.toHaveBeenCalled();
  });
});

describe("isolated runtime framing", () => {
  it("decodes fragmented Docker headers and UTF-8 characters across stdout frames", () => {
    const events: unknown[] = [];
    const decode = processFrameDecoder((event) => events.push(event));
    const utf8 = Buffer.from("你好");
    const bytes = Buffer.concat([
      frame(1, utf8.subarray(0, 2)),
      frame(2, "error"),
      frame(1, utf8.subarray(2)),
    ]);
    for (const byte of bytes) decode.push(Buffer.from([byte]));
    decode.finish();
    expect(events).toEqual([
      { type: "stderr", data: "error" },
      { type: "stdout", data: "你好" },
    ]);
  });

  it("rejects truncated and oversized frames", () => {
    const decode = processFrameDecoder(() => undefined);
    decode.push(frame(1, "test").subarray(0, 9));
    expect(() => decode.finish()).toThrow(/Truncated/);
    const oversized = Buffer.alloc(8);
    oversized[0] = 1;
    oversized.writeUInt32BE(2 * 1024 * 1024, 4);
    expect(() => processFrameDecoder(() => undefined).push(oversized)).toThrow(/Invalid/);
  });
});

describe("isolated runtime lifecycle", () => {
  it("bounds UTF-8 input and aggregate queued media independently of frame count", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const { id } = await fake.manager.start(identity, request, new AbortController().signal);
    const process = fake.manager.get(id, identity);
    await expect(process.input("界".repeat(6 * 1024 * 1024))).rejects.toThrow(/limit/);
    let release!: () => void;
    fake.stream._write = (_chunk, _encoding, callback) => {
      release = () => callback();
    };
    const input = "x".repeat(12 * 1024 * 1024);
    const one = process.input(input);
    const two = process.input(input);
    await expect(process.input(input)).rejects.toThrow(/limit/);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await one;
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await two;
    fake.stream._write = (_chunk, _encoding, callback) => callback();
    await process.input("released");
    await process.terminate();
  });

  it("streams output, orders stdin and closes it without ending stdout", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const { id, body } = await fake.manager.start(identity, request, new AbortController().signal);
    const process = fake.manager.get(id, identity);
    await Promise.all([process.input("first"), process.input("second"), process.closeInput()]);
    expect(fake.inputs).toEqual([
      `${JSON.stringify({ argv: request.argv, env: {} })}\n`,
      "first",
      "second",
    ]);
    expect(fake.inputEnd).toHaveBeenCalledOnce();
    const output = new Response(body).text();
    fake.stream.push(frame(1, "result"));
    fake.stream.push(null);
    fake.exit({ StatusCode: 7 });
    expect(await output).toContain('"code":7');
    await vi.waitFor(() => expect(fake.container.remove).toHaveBeenCalledWith({ force: true }));
    expect(fake.network.remove).toHaveBeenCalledOnce();
  });

  it("kills the whole container on disconnect and abort and makes cleanup idempotent", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const abort = new AbortController();
    const { id, body } = await fake.manager.start(identity, request, abort.signal);
    const process = fake.manager.get(id, identity);
    abort.abort();
    await process.terminate();
    await body.cancel();
    expect(fake.container.remove).toHaveBeenCalledOnce();
    expect(fake.container.remove).toHaveBeenCalledWith({ force: true });
    expect(fake.stream.destroyed).toBe(true);
    expect(() => fake.manager.get(id, identity)).toThrow(/not found/);
  });

  it("enforces timeout and run/computer/tenant/user isolation on every control operation", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    vi.useFakeTimers();
    const fake = fakeDocker();
    const { id, body } = await fake.manager.start(
      identity,
      { ...request, timeoutMs: 30 },
      new AbortController().signal,
    );
    for (const field of ["computerId", "computerBotId", "spaceId", "botId", "runId", "userId"]) {
      expect(() => fake.manager.get(id, { ...identity, [field]: "other" })).toThrow(/not found/);
    }
    const output = new Response(body).text();
    await vi.advanceTimersByTimeAsync(30);
    expect(await output).toContain('"code":124');
    expect(fake.container.remove).toHaveBeenCalledWith({ force: true });
  });

  it("fences concurrent session mounts, keeps state on stop and deletes it on computer destruction", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const { id } = await fake.manager.start(
      identity,
      { ...request, sessionScope: scope },
      new AbortController().signal,
    );
    await expect(
      fake.manager.start(
        { ...identity, runId: "other" },
        { ...request, sessionScope: scope },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/already leased/);
    expect(fake.volumes.size).toBe(1);
    await fake.manager.stopComputer(identity.computerId);
    expect(fake.volumes.size).toBe(1);
    expect(() => fake.manager.get(id, identity)).toThrow();
    await fake.manager.destroyComputer(identity.computerBotId, identity.spaceId);
    expect(fake.volumes.size).toBe(0);
  });

  it("cleans scoped volumes after a disabled cold restart without initializing native processes", async () => {
    vi.stubEnv("PRIMARY_HARNESSES_ENABLED", "false");
    const fake = fakeDocker();
    const labels = {
      "rakazo.harnessSessionOwner": "installation",
      "rakazo.harnessSessionComputer": identity.computerBotId,
      "rakazo.harnessSessionSpace": identity.spaceId,
    };
    for (const [name, extra] of Object.entries({
      own: {},
      foreignOwner: { "rakazo.harnessSessionOwner": "other" },
      foreignComputer: { "rakazo.harnessSessionComputer": "other" },
      foreignSpace: { "rakazo.harnessSessionSpace": "other" },
    }))
      fake.volumes.set(name, { Name: name, Labels: { ...labels, ...extra } });
    fake.volumes.set("legacy", {
      Name: "legacy",
      Labels: {
        "rakazo.harnessSessionOwner": "installation",
        "rakazo.harnessSessionComputer": identity.computerBotId,
      },
    });
    await fake.manager.destroyComputer(identity.computerBotId, identity.spaceId);
    expect(fake.removeVolume.mock.calls).toEqual([["own"]]);
    expect(fake.docker.listContainers).not.toHaveBeenCalled();
    expect(fake.docker.listNetworks).not.toHaveBeenCalled();
    expect(fake.docker.info).not.toHaveBeenCalled();
    await fake.manager.destroyComputer(identity.computerBotId, identity.spaceId, true);
    expect(fake.removeVolume.mock.calls).toEqual([["own"], ["legacy"]]);
    expect(fake.volumes.size).toBe(3);
  });

  it("never removes a leased volume while its process is still starting", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.docker.createNetwork.mockImplementation(async () => {
      await paused;
      return fake.network;
    });
    const starting = fake.manager.start(
      identity,
      { ...request, sessionScope: scope },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(fake.docker.createNetwork).toHaveBeenCalledOnce());
    await expect(
      fake.manager.destroyComputer(identity.computerBotId, identity.spaceId),
    ).rejects.toThrow(/leased/);
    expect(fake.removeVolume).not.toHaveBeenCalled();
    release();
    await starting;
    await fake.manager.destroyComputer(identity.computerBotId, identity.spaceId);
    expect(fake.volumes.size).toBe(0);
  });

  it("removes failed-start containers and network resources", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    fake.container.start.mockRejectedValueOnce(new Error("failed"));
    await expect(
      fake.manager.start(identity, request, new AbortController().signal),
    ).rejects.toThrow("failed");
    expect(fake.container.remove).toHaveBeenCalledWith({ force: true });
    expect(fake.network.remove).toHaveBeenCalledOnce();
  });

  it("fences a launch still allocating resources when the supervisor shuts down", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.docker.createNetwork.mockImplementationOnce(async () => {
      await gate;
      return fake.network;
    });
    const starting = fake.manager.start(identity, request, new AbortController().signal);
    await vi.waitFor(() => expect(fake.docker.createNetwork).toHaveBeenCalledOnce());
    await fake.manager.close();
    release();
    await expect(starting).rejects.toThrow(/stopping/);
    expect(fake.docker.createContainer).not.toHaveBeenCalled();
    expect(fake.network.remove).toHaveBeenCalledOnce();
  });

  it("allows authenticated termination after the feature is switched off", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    vi.stubEnv("PRIMARY_HARNESSES_ENABLED", "true");
    const fake = fakeDocker();
    const { id } = await fake.manager.start(identity, request, new AbortController().signal);
    const app = isolatedProcessRoutes(fake.manager, (_identity, launch) => launch());
    vi.stubEnv("PRIMARY_HARNESSES_ENABLED", "false");
    const result = await app.request(`/computer/processes/${id}`, {
      method: "DELETE",
      headers: {
        "x-rakazo-bot-id": "team",
        "x-rakazo-space-id": "space",
        "x-rakazo-runtime-bot-id": "bot",
        "x-rakazo-runtime-user-id": "user",
        "x-rakazo-run-id": "run",
      },
    });
    expect(result.status).toBe(200);
    expect(fake.container.remove).toHaveBeenCalledWith({ force: true });
  });

  it("rejects disabled routes before touching Docker", async () => {
    const fake = fakeDocker();
    const authorize = vi.fn((_identity, launch) => launch());
    const app = isolatedProcessRoutes(fake.manager, authorize);
    const result = await app.request("/computer/processes", {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(result.status).toBe(503);
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe("private native account state", () => {
  const credentialScope = { harness: "codex" as const, connectionId: "connection", epoch: "epoch" };
  const nativeRequest = { ...request, sessionScope: scope, credentialScope };

  it("binds account volume to installation, user, computer, harness, account and epoch, not bot or run", () => {
    const name = credentialVolumeName("installation", identity, credentialScope);
    expect(name).toMatch(/^rakazo-harness-credential-[a-f0-9]{64}$/);
    expect(
      credentialVolumeName(
        "installation",
        { ...identity, botId: "other-bot", runId: "other-run" },
        credentialScope,
      ),
    ).toBe(name);
    for (const changed of [{ userId: "other" }, { spaceId: "other" }, { computerBotId: "other" }]) {
      expect(
        credentialVolumeName("installation", { ...identity, ...changed }, credentialScope),
      ).not.toBe(name);
    }
    for (const changed of [
      { harness: "kimi" as const },
      { connectionId: "other" },
      { epoch: "other" },
    ]) {
      expect(
        credentialVolumeName("installation", identity, { ...credentialScope, ...changed }),
      ).not.toBe(name);
    }
    expect(credentialVolumeName("other", identity, credentialScope)).not.toBe(name);
    expect(isolatedProcessRequest.safeParse(nativeRequest).success).toBe(true);
    for (const key of [
      "OPENAI_API_KEY",
      "KIMI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
    ]) {
      expect(
        isolatedProcessRequest.safeParse({ ...nativeRequest, env: { [key]: "fake-key" } }).success,
      ).toBe(false);
    }
    expect(
      nativeStateCleanupRequest.safeParse({ sessionScope: scope, credentialScope }).success,
    ).toBe(false);
    expect(nativeStateCleanupRequest.safeParse({}).success).toBe(false);
  });

  it("mounts separate transcript and credential volumes, and exclusively leases the credential across bots", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const { id } = await fake.manager.start(identity, nativeRequest, new AbortController().signal);
    const options = fake.docker.createContainer.mock.calls[0]?.[0] as
      | Docker.ContainerCreateOptions
      | undefined;
    expect(options?.HostConfig?.Mounts).toEqual([
      {
        Type: "volume",
        Source: sessionVolumeName("installation", identity, scope),
        Target: "/sessions",
        ReadOnly: false,
      },
      {
        Type: "volume",
        Source: credentialVolumeName("installation", identity, credentialScope),
        Target: "/credentials",
        ReadOnly: false,
      },
    ]);
    await expect(
      fake.manager.start(
        { ...identity, botId: "other" },
        nativeRequest,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/leased/);
    await expect(
      fake.manager.cleanupNativeState(identity, {
        expectedInstallationId: "installation",
        credentialScope,
      }),
    ).rejects.toThrow(/leased/);
    await fake.manager.get(id, identity).terminate();
    expect(fake.volumes.size).toBe(2);
    await fake.manager.cleanupNativeState(identity, {
      expectedInstallationId: "installation",
      credentialScope,
    });
    expect(fake.volumes.size).toBe(1);
    expect(fake.volumes.has(sessionVolumeName("installation", identity, scope))).toBe(true);
    await fake.manager.cleanupNativeState(identity, {
      expectedInstallationId: "installation",
      sessionScope: scope,
    });
    expect(fake.volumes.size).toBe(0);
  });

  it("releases all allocation leases when creating one of the private volumes fails", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    fake.docker.createVolume.mockRejectedValueOnce(new Error("allocation failed"));
    await expect(
      fake.manager.start(identity, nativeRequest, new AbortController().signal),
    ).rejects.toThrow(/allocation failed/);
    const { id } = await fake.manager.start(identity, nativeRequest, new AbortController().signal);
    await fake.manager.get(id, identity).terminate();
  });

  it("reserves the exact cleanup scope before inspection so launch cannot race deletion", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const { id } = await fake.manager.start(identity, nativeRequest, new AbortController().signal);
    await fake.manager.get(id, identity).terminate();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.removeVolume.mockImplementationOnce(async (name) => {
      await gate;
      fake.volumes.delete(name);
    });
    const deleting = fake.manager.cleanupNativeState(identity, {
      expectedInstallationId: "installation",
      credentialScope,
    });
    await vi.waitFor(() => expect(fake.removeVolume).toHaveBeenCalledOnce());
    await expect(
      fake.manager.start(identity, nativeRequest, new AbortController().signal),
    ).rejects.toThrow(/leased/);
    release();
    await deleting;
    expect(fake.volumes.has(credentialVolumeName("installation", identity, credentialScope))).toBe(
      false,
    );
  });

  it("refuses prior-installation cleanup before even checking for an absent volume", async () => {
    const fake = fakeDocker();
    await expect(
      fake.manager.cleanupNativeState(identity, {
        expectedInstallationId: "prior-installation",
        credentialScope,
      }),
    ).rejects.toThrow(/different installation/);
    expect(fake.docker.getVolume).not.toHaveBeenCalled();
  });

  it("does not remove foreign scopes or mislabeled volumes and handles absence idempotently", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const { id } = await fake.manager.start(identity, nativeRequest, new AbortController().signal);
    await fake.manager.get(id, identity).terminate();
    await fake.manager.cleanupNativeState(
      { ...identity, userId: "other" },
      { expectedInstallationId: "installation", credentialScope },
    );
    expect(fake.removeVolume).not.toHaveBeenCalled();
    const volume = fake.volumes.get(
      credentialVolumeName("installation", identity, credentialScope),
    )!;
    volume.Labels["rakazo.harnessSessionOwner"] = "foreign";
    await expect(
      fake.manager.cleanupNativeState(identity, {
        expectedInstallationId: "installation",
        credentialScope,
      }),
    ).rejects.toThrow(/ownership mismatch/);
    expect(fake.removeVolume).not.toHaveBeenCalled();
    volume.Labels["rakazo.harnessSessionOwner"] = "installation";
    fake.removeVolume.mockRejectedValueOnce({ statusCode: 409 });
    await expect(
      fake.manager.cleanupNativeState(identity, {
        expectedInstallationId: "installation",
        credentialScope,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // A failed deletion releases only its cleanup reservation, so the retry can succeed.
    await fake.manager.cleanupNativeState(identity, {
      expectedInstallationId: "installation",
      credentialScope,
    });
    await fake.manager.cleanupNativeState(identity, {
      expectedInstallationId: "installation",
      credentialScope,
    });
    expect(fake.removeVolume).toHaveBeenCalledTimes(2);
  });

  it("holds every computer deletion lease until all removals finish", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const { id } = await fake.manager.start(identity, nativeRequest, new AbortController().signal);
    await fake.manager.get(id, identity).terminate();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.removeVolume.mockImplementationOnce(async (name) => {
      await gate;
      fake.volumes.delete(name);
    });
    const deleting = fake.manager.destroyComputer(identity.computerBotId, identity.spaceId);
    await vi.waitFor(() => expect(fake.removeVolume).toHaveBeenCalledOnce());
    await expect(
      fake.manager.start(
        { ...identity, botId: "other" },
        nativeRequest,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/leased/);
    await expect(
      fake.manager.cleanupNativeState(identity, {
        expectedInstallationId: "installation",
        credentialScope,
      }),
    ).rejects.toThrow(/leased/);
    release();
    await deleting;
    expect(fake.volumes.size).toBe(0);
  });

  it("removes account state with its computer even after the feature is disabled", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    const { id } = await fake.manager.start(identity, nativeRequest, new AbortController().signal);
    await fake.manager.get(id, identity).terminate();
    vi.stubEnv("PRIMARY_HARNESSES_ENABLED", "false");
    await fake.manager.destroyComputer(identity.computerBotId, identity.spaceId);
    expect(fake.volumes.size).toBe(0);
  });

  it("authorizes exact-scope cleanup while disabled and refuses absent authorization", async () => {
    vi.stubEnv("PRIMARY_HARNESSES_ENABLED", "false");
    const fake = fakeDocker();
    const cleanup = vi.fn(async (_identity, operation) => operation());
    const app = isolatedProcessRoutes(fake.manager, (_identity, launch) => launch(), cleanup);
    const options = {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-rakazo-bot-id": "team",
        "x-rakazo-space-id": "space",
        "x-rakazo-runtime-bot-id": "bot",
        "x-rakazo-runtime-user-id": "user",
        "x-rakazo-run-id": "run",
      },
      body: JSON.stringify({ expectedInstallationId: "installation", credentialScope }),
    };
    expect((await app.request("/computer/native-state", options)).status).toBe(200);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(identity, expect.any(Function));
    expect((await app.request("/computer/native-state", { ...options, headers: {} })).status).toBe(
      503,
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(
      (await app.request("/computer/native-state", { ...options, body: JSON.stringify({}) }))
        .status,
    ).toBe(400);
    const unconfigured = isolatedProcessRoutes(fake.manager, (_identity, launch) => launch());
    expect((await unconfigured.request("/computer/native-state", options)).status).toBe(503);
    expect(fake.docker.createContainer).not.toHaveBeenCalled();
  });
});

describe("private native session family cleanup", () => {
  const childScope = { ...scope, epoch: "helper-derived", parentEpoch: scope.epoch };
  const cleanup = { expectedInstallationId: "installation", sessionScope: scope };
  async function allocate(
    fake: ReturnType<typeof fakeDocker>,
    sessionScope = scope,
    owner = identity,
  ) {
    // Each isolated process has a fresh attachment; a terminated stream cannot be reused.
    fake.container.attach.mockImplementation(
      async () =>
        new Duplex({
          read() {},
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
    );
    const { id } = await fake.manager.start(
      owner,
      { ...request, sessionScope },
      new AbortController().signal,
    );
    await fake.manager.get(id, owner).terminate();
  }

  it("shares only the cleanup family, never the transcript namespace, with a helper", () => {
    expect(sessionFamilyName("installation", identity, childScope)).toBe(
      sessionFamilyName("installation", identity, scope),
    );
    expect(sessionVolumeName("installation", identity, childScope)).not.toBe(
      sessionVolumeName("installation", identity, scope),
    );
    expect(
      sessionFamilyName("installation", { ...identity, computerBotId: "other" }, scope),
    ).not.toBe(sessionFamilyName("installation", identity, scope));
    expect(
      sessionFamilyName("installation", identity, { ...childScope, parentEpoch: "other" }),
    ).not.toBe(sessionFamilyName("installation", identity, scope));
  });

  it("deletes only the exact family, including a legacy root and newly scoped children", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    await allocate(fake);
    const root = fake.volumes.get(sessionVolumeName("installation", identity, scope))!;
    delete root.Labels["rakazo.harnessSessionFamily"];
    delete root.Labels["rakazo.harnessSessionSpace"];
    await allocate(fake, childScope);
    await allocate(fake, { ...scope, epoch: "fresh-root" });
    await allocate(fake, childScope, { ...identity, userId: "other-user" });
    await allocate(fake, childScope, { ...identity, botId: "other-bot" });
    expect(fake.volumes.size).toBe(5);
    await fake.manager.cleanupNativeState(identity, cleanup);
    expect(fake.volumes.size).toBe(3);
    expect(fake.volumes.has(root.Name)).toBe(false);
    expect(fake.volumes.has(sessionVolumeName("installation", identity, childScope))).toBe(false);
    expect(fake.removeVolume).toHaveBeenCalledTimes(2);
    await fake.manager.cleanupNativeState(identity, cleanup);
    expect(fake.removeVolume).toHaveBeenCalledTimes(2);
  });

  it("refuses a helper allocation lease before its volume exists", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    await allocate(fake);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.docker.createVolume.mockImplementationOnce(async (volume) => {
      await gate;
      fake.volumes.set(volume.Name, volume);
      return volume;
    });
    const starting = fake.manager.start(
      identity,
      { ...request, sessionScope: childScope },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(fake.docker.createVolume).toHaveBeenCalledTimes(2));
    await expect(fake.manager.cleanupNativeState(identity, cleanup)).rejects.toThrow(/leased/);
    expect(fake.removeVolume).not.toHaveBeenCalled();
    release();
    const { id } = await starting;
    await fake.manager.get(id, identity).terminate();
    await fake.manager.cleanupNativeState(identity, cleanup);
    expect(fake.volumes.size).toBe(0);
  });

  it("fences a new child namespace while its parent family is being deleted", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    await allocate(fake);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.removeVolume.mockImplementationOnce(async (name) => {
      await gate;
      fake.volumes.delete(name);
    });
    const deleting = fake.manager.cleanupNativeState(identity, cleanup);
    await vi.waitFor(() => expect(fake.removeVolume).toHaveBeenCalledOnce());
    await expect(
      fake.manager.start(
        identity,
        { ...request, sessionScope: childScope },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/family is being removed/);
    release();
    await deleting;
    expect(fake.volumes.size).toBe(0);
  });

  it("checks orphan mounts before deleting any family member and keeps the deletion retryable", async () => {
    vi.stubEnv("PRIMARY_HARNESS_EGRESS_VERIFIED", "true");
    const fake = fakeDocker();
    await allocate(fake);
    await allocate(fake, childScope);
    fake.docker.listContainers.mockResolvedValueOnce([{ Id: "mounted-orphan" }] as never);
    await expect(fake.manager.cleanupNativeState(identity, cleanup)).rejects.toThrow(/mounted/);
    expect(fake.removeVolume).not.toHaveBeenCalled();
    await fake.manager.cleanupNativeState(identity, cleanup);
    expect(fake.volumes.size).toBe(0);
  });
});
