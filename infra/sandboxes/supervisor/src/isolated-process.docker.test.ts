import { randomUUID } from "node:crypto";
import Docker from "dockerode";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessIdentity } from "./isolated-process.js";
import { IsolatedProcessManager, sessionFamilyName } from "./isolated-process.js";

// Explicit opt-in only. Requires a prebuilt trusted image and the documented host firewall.
// Never builds/pulls images, changes firewall rules, or contacts a model provider.
const enabled = process.env.RAKAZO_HARNESS_DOCKER_TESTS === "1";
const docker = process.env.DOCKER_HOST
  ? new Docker()
  : new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
const owner = `offline-runtime-test-${randomUUID()}`;
const identity: ProcessIdentity = {
  computerId: owner,
  computerBotId: owner,
  spaceId: owner,
  userId: owner,
  botId: owner,
  runId: owner,
};
const manager = new IsolatedProcessManager(docker, "restricted", owner);
const signal = () => new AbortController().signal;
const command = (code: string) => ({
  isolation: "primary-harness" as const,
  argv: ["python3", "-I", "-u", "-c", code],
  timeoutMs: 10_000,
});

describe.skipIf(!enabled)("real isolated Docker runtime (offline opt-in)", () => {
  afterEach(async () => {
    await manager.stopComputer(identity.computerId);
    await manager.destroyComputer(identity.computerBotId, identity.spaceId);
  });

  it("supports stdin/stdout and keeps credentials out of inspect/argv", async () => {
    const started = await manager.start(
      identity,
      {
        ...command(
          "import os,sys; print('ready',flush=True); print(sys.stdin.readline().strip(),flush=True); assert os.getenv('OPENAI_API_KEY') == 'fake-offline-key'",
        ),
        env: { OPENAI_API_KEY: "fake-offline-key" },
      },
      signal(),
    );
    const containers = await docker.listContainers({
      filters: { label: [`rakazo.harnessOwner=${owner}`] },
    });
    expect(containers).toHaveLength(1);
    const inspected = await docker.getContainer(containers[0]!.Id).inspect();
    expect(JSON.stringify({ cmd: inspected.Config.Cmd, env: inspected.Config.Env })).not.toContain(
      "fake-offline-key",
    );
    await manager.get(started.id, identity).input("你好\n");
    const output = await new Response(started.body).text();
    expect(output).toContain("你好");
    expect(output).toContain('"code":0');
  });

  it("removes the PID namespace even when a child detached into a new session", async () => {
    const started = await manager.start(
      identity,
      command(
        "import subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True); print(child.pid,flush=True); time.sleep(60)",
      ),
      signal(),
    );
    const reader = started.body.getReader();
    await reader.read();
    await reader.read();
    await manager.get(started.id, identity).terminate();
    await reader.cancel();
    expect(
      await docker.listContainers({
        all: true,
        filters: { label: [`rakazo.harnessOwner=${owner}`] },
      }),
    ).toHaveLength(0);
  });

  it("persists only the explicitly scoped session mount across process replacement", async () => {
    const sessionScope = {
      threadId: owner,
      profileId: owner,
      profileRevision: 1,
      accountId: owner,
      epoch: "epoch",
    };
    const first = await manager.start(
      identity,
      {
        ...command(
          "import pathlib; pathlib.Path('/sessions/state').write_text('saved'); pathlib.Path('/home/harness/transient').write_text('discard')",
        ),
        sessionScope,
      },
      signal(),
    );
    expect(await new Response(first.body).text()).toContain('"code":0');
    const second = await manager.start(
      { ...identity, runId: `${owner}-next` },
      {
        ...command(
          "import pathlib; assert not pathlib.Path('/home/harness/transient').exists(); print(pathlib.Path('/sessions/state').read_text())",
        ),
        sessionScope,
      },
      signal(),
    );
    const output = await new Response(second.body).text();
    expect(output).toContain("saved");
    expect(output).toContain('"code":0');
  });

  it("persists a native credential only within the exact user/computer account namespace", async () => {
    const credentialScope = { harness: "codex" as const, connectionId: owner, epoch: "credential" };
    const first = await manager.start(
      identity,
      {
        ...command(
          "import pathlib; pathlib.Path('/credentials/fake-auth').write_text('fake-offline-credential'); pathlib.Path('/home/harness/transient-config').write_text('discard')",
        ),
        credentialScope,
      },
      signal(),
    );
    expect(await new Response(first.body).text()).toContain('"code":0');
    const secondIdentity = { ...identity, botId: `${owner}-other-bot`, runId: `${owner}-next` };
    const second = await manager.start(
      secondIdentity,
      {
        ...command(
          "import pathlib; assert pathlib.Path('/credentials/fake-auth').read_text() == 'fake-offline-credential'; assert not pathlib.Path('/home/harness/transient-config').exists(); print('scoped')",
        ),
        credentialScope,
      },
      signal(),
    );
    expect(await new Response(second.body).text()).toContain('"code":0');
    const foreignIdentity = { ...identity, userId: `${owner}-other-user` };
    const foreign = await manager.start(
      foreignIdentity,
      {
        ...command(
          "import pathlib; assert not pathlib.Path('/credentials/fake-auth').exists(); print('isolated')",
        ),
        credentialScope,
      },
      signal(),
    );
    expect(await new Response(foreign.body).text()).toContain('"code":0');
    await manager.cleanupNativeState(identity, { expectedInstallationId: owner, credentialScope });
    await manager.cleanupNativeState(foreignIdentity, {
      expectedInstallationId: owner,
      credentialScope,
    });
  });

  it("removes the exact root/helper transcript family after all processes release it", async () => {
    const sessionScope = {
      threadId: owner,
      profileId: owner,
      profileRevision: 1,
      accountId: owner,
      epoch: "family-root",
    };
    for (const scope of [
      sessionScope,
      { ...sessionScope, epoch: "helper", parentEpoch: sessionScope.epoch },
    ]) {
      const started = await manager.start(
        identity,
        {
          ...command(
            "import pathlib; pathlib.Path('/sessions/transcript').write_text('offline-test')",
          ),
          sessionScope: scope,
        },
        signal(),
      );
      expect(await new Response(started.body).text()).toContain('"code":0');
    }
    const filter = {
      filters: {
        label: [
          `rakazo.harnessSessionOwner=${owner}`,
          `rakazo.harnessSessionFamily=${sessionFamilyName(owner, identity, sessionScope)}`,
        ],
      },
    };
    expect((await docker.listVolumes(filter)).Volumes).toHaveLength(2);
    await manager.cleanupNativeState(identity, { expectedInstallationId: owner, sessionScope });
    expect((await docker.listVolumes(filter)).Volumes ?? []).toHaveLength(0);
  });
});
