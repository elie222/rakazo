import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdaterCommandRunner } from "./index.js";
import { createUpdaterApp } from "./index.js";
import { pruneComputerCache } from "./runtime-state.js";
import { resolveUpdaterConfig } from "./updater-logic.js";

const older = "1".repeat(40);
const newer = "2".repeat(40);
const appImage = "ghcr.io/elie222/rakazo/app";
const computerImage = "ghcr.io/elie222/rakazo/computer";
const cachePrefix = `cached-${createHash("sha256").update("cache-test").digest("hex").slice(0, 16)}-`;
const cachedOlder = `${cachePrefix}${"1".repeat(64)}`;
const cachedNewer = `${cachePrefix}${"2".repeat(64)}`;
const token = "fake-scheduled-recovery-token-00000000";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function fixture(env: string, commit: string, computers = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scheduled-recovery-"));
  directories.push(dir);
  const envFile = path.join(dir, ".env");
  await writeFile(envFile, env);
  const config = resolveUpdaterConfig({
    RAKAZO_DEPLOY_DIR: dir,
    RAKAZO_UPDATER_TOKEN: token,
    COMPOSE_PROJECT_NAME: "cache-test",
  });
  if (computers) config.updateServices = ["api", "worker", "web", "supervisor", "computer"];
  const state = {
    versions: {
      api: commit,
      worker: commit,
      web: commit,
      ...(computers ? { supervisor: commit } : {}),
    } as Record<string, string>,
    computer: `${computerImage}:sha-${older}`,
    images: {
      [`sha-${older}`]: `sha256:${"1".repeat(64)}`,
      [`sha-${newer}`]: `sha256:${"2".repeat(64)}`,
      latest: `sha256:${"1".repeat(64)}`,
    } as Record<string, string>,
    unavailableComputer: false,
    failTarget: false,
  };
  const ids = {
    api: "a".repeat(12),
    worker: "b".repeat(12),
    web: "c".repeat(12),
    supervisor: "d".repeat(12),
  };
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const run: UpdaterCommandRunner = async (command, args, options) => {
    calls.push({ args, env: options.env ?? {} });
    const ok = (stdout = "") => ({ ok: true, exitCode: 0, stdout, output: stdout });
    const failed = (output: string) => ({ ok: false, exitCode: 1, stdout: "", output });
    if (command === "git") return ok(`${older}\trefs/tags/v1.0.0\n${newer}\trefs/tags/v1.1.0\n`);
    if (args[0] === "ps") {
      const service = args
        .find((arg) => arg.startsWith("label=com.docker.compose.service="))
        ?.split("=")
        .at(-1);
      if (!service || !(service in ids)) throw new Error("Unexpected runtime lookup");
      return ok(state.versions[service] ? ids[service as keyof typeof ids] : "");
    }
    if (args[0] === "exec" || args[0] === "inspect") {
      const service = Object.keys(ids).find((name) => ids[name as keyof typeof ids] === args[1]);
      if (!service) throw new Error("Unexpected container");
      if (args[0] === "inspect") return ok(`sha256:${state.versions[service]?.[0]?.repeat(64)}`);
      return ok(args.at(-1) === "process.env.GIT_SHA" ? state.versions[service] : state.computer);
    }
    if (args[0] === "image" && args[1] === "ls") return ok(Object.keys(state.images).join("\n"));
    if (args[0] === "image" && args[1] === "rm") {
      delete state.images[args[2]?.split(":").at(-1) ?? ""];
      return ok();
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const tag = args[2]?.split(":").at(-1) ?? "";
      return state.images[tag] ? ok(state.images[tag]) : failed("image unavailable");
    }
    if (args[0] === "image" && args[1] === "tag") {
      if (args[3]?.startsWith(`${computerImage}:`))
        state.images[args[3].slice(computerImage.length + 1)] = args[2] ?? "";
      return ok();
    }
    if (args.includes("pull")) {
      if (computers && state.unavailableComputer)
        return failed("computer commit image is not published yet");
      return ok();
    }
    if (args.includes("up")) {
      if (state.failTarget && options.env?.RAKAZO_IMAGE_TAG === `sha-${newer}`)
        return failed("target unhealthy");
      const next = options.env?.RAKAZO_IMAGE_TAG?.slice(4);
      if (!next) throw new Error("Missing application pin");
      for (const service of Object.keys(state.versions)) state.versions[service] = next;
      if (options.env?.RAKAZO_COMPUTER_IMAGE_TAG)
        state.computer = `${computerImage}:${options.env.RAKAZO_COMPUTER_IMAGE_TAG}`;
      return ok();
    }
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  };
  return {
    app: createUpdaterApp(config, { run }),
    state,
    calls,
    env: () => readFile(envFile, "utf8"),
  };
}

describe("scheduled release state and recovery", () => {
  it("aligns stale pins with the verified running image without a deployment", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_IMAGE_TAG_PREVIOUS=v0.9.0\n`,
      newer,
    );
    const result = await subject.app.applyScheduledUpdate();
    expect(result.ok).toBe(true);
    expect(result.restart).toBe("not-required");
    expect(await subject.env()).toContain(`RAKAZO_IMAGE_TAG=sha-${newer}\n`);
    expect(await subject.env()).toContain("RAKAZO_IMAGE_TAG_PREVIOUS=v0.9.0\n");
    expect(subject.calls.some(({ args }) => args.includes("pull") || args.includes("up"))).toBe(
      false,
    );
    expect(subject.calls).toContainEqual({
      args: ["image", "tag", `sha256:${"2".repeat(64)}`, `${appImage}:sha-${newer}`],
      env: {},
    });
  });

  it("does not retry a failed target as recovery for a mixed runtime", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${newer}\nRAKAZO_IMAGE_TAG_PREVIOUS=sha-${older}\n`,
      newer,
    );
    subject.state.versions.worker = older;
    subject.state.failTarget = true;
    const result = await subject.app.applyScheduledUpdate();
    expect(result.ok).toBe(false);
    expect(result.restart).toBe("manual");
    expect(result.restartAdvice).toContain("not retried as recovery");
    expect(subject.calls.filter(({ args }) => args.includes("up"))).toHaveLength(1);
    expect(result.steps.some((step) => step.id === "recover")).toBe(false);
    expect(await subject.env()).toContain(`RAKAZO_IMAGE_TAG_PREVIOUS=sha-${older}`);
  });

  it("does not treat an already-staged target computer as a previous release", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=sha-${newer}\n`,
      older,
      true,
    );
    subject.state.computer = `${computerImage}:sha-${newer}`;
    subject.state.failTarget = true;
    const result = await subject.app.applyScheduledUpdate();
    expect(result.restart).toBe("manual");
    expect(result.steps.some((step) => step.id === "recover")).toBe(false);
    expect(subject.calls.filter(({ args }) => args.includes("up"))).toHaveLength(1);
  });

  it("restores the verified running baseline rather than a stale .env tag", async () => {
    const subject = await fixture("RAKAZO_IMAGE_TAG=v0.9.0\n", older);
    subject.state.failTarget = true;
    const result = await subject.app.applyScheduledUpdate();
    expect(result.ok).toBe(false);
    expect(result.restart).toBe("not-required");
    expect(result.fromTag).toBe(`sha-${older}`);
    expect(
      subject.calls
        .filter(({ args }) => args.includes("up"))
        .map(({ env }) => env.RAKAZO_IMAGE_TAG),
    ).toEqual([`sha-${newer}`, `sha-${older}`]);
    expect(await subject.env()).toContain(`RAKAZO_IMAGE_TAG=sha-${older}\n`);
  });

  it("restores the previous computer pin on a failed release update", async () => {
    const subject = await fixture(
      "RAKAZO_IMAGE_TAG=v0.9.0\nRAKAZO_COMPUTER_IMAGE_TAG=latest\n",
      older,
      true,
    );
    subject.state.failTarget = true;
    const result = await subject.app.applyScheduledUpdate();
    expect(result.restart).toBe("not-required");
    expect(result.fromCommit).toBe(older);
    expect(
      subject.calls
        .filter(({ args }) => args.includes("up"))
        .map(({ env }) => [env.RAKAZO_IMAGE_TAG, env.RAKAZO_COMPUTER_IMAGE_TAG]),
    ).toEqual([
      [`sha-${newer}`, `sha-${newer}`],
      [`sha-${older}`, cachedOlder],
    ]);
    expect(subject.state.computer).toBe(`${computerImage}:${cachedOlder}`);
    expect(await subject.env()).toContain(`RAKAZO_COMPUTER_IMAGE_TAG=${cachedOlder}\n`);
  });

  it("waits for the exact computer commit image and never relies on computer:latest", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${newer}\nRAKAZO_COMPUTER_IMAGE_TAG=latest\n`,
      newer,
      true,
    );
    subject.state.computer = `${computerImage}:latest`;
    subject.state.unavailableComputer = true;
    const beforePublication = await subject.app.applyScheduledUpdate();
    expect(beforePublication.ok).toBe(false);
    expect(subject.calls.filter(({ args }) => args.includes("up"))).toHaveLength(0);
    subject.state.unavailableComputer = false;
    const afterPublication = await subject.app.applyScheduledUpdate();
    expect(afterPublication.ok).toBe(true);
    expect(subject.state.computer).toBe(`${computerImage}:sha-${newer}`);
    expect(await subject.env()).toContain(`RAKAZO_COMPUTER_IMAGE_TAG=sha-${newer}\n`);
    expect(
      subject.calls
        .filter(({ args }) => args.includes("pull"))
        .every(({ env }) => env.RAKAZO_COMPUTER_IMAGE_TAG === `sha-${newer}`),
    ).toBe(true);
    const deployments = subject.calls.filter(({ args }) => args.includes("up")).length;
    await subject.app.applyScheduledUpdate();
    expect(subject.calls.filter(({ args }) => args.includes("up"))).toHaveLength(deployments);
  });

  it("refuses application rollback when managed computer history is missing", async () => {
    const env = `RAKAZO_IMAGE_TAG=sha-${newer}\nRAKAZO_IMAGE_TAG_PREVIOUS=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=sha-${newer}\n`;
    const subject = await fixture(env, newer, true);
    const response = await subject.app.request("/rollback", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("previous computer image pin");
    expect(await subject.env()).toBe(env);
    expect(subject.calls).toHaveLength(0);
  });

  it("preserves computer history when only the application image changes", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=sha-${newer}\nRAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${cachedOlder}\n`,
      older,
      true,
    );
    subject.state.computer = `${computerImage}:sha-${newer}`;
    subject.state.images[cachedOlder] = `sha256:${"1".repeat(64)}`;
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
    expect(await subject.env()).toContain(`RAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${cachedOlder}\n`);
    expect(subject.state.images[cachedOlder]).toBeDefined();
  });

  it("saves the replaced computer during a computer-only repair", async () => {
    const obsolete = `${cachePrefix}${"3".repeat(64)}`;
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${newer}\nRAKAZO_IMAGE_TAG_PREVIOUS=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=latest\nRAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${obsolete}\n`,
      newer,
      true,
    );
    subject.state.computer = `${computerImage}:latest`;
    subject.state.images[obsolete] = `sha256:${"3".repeat(64)}`;
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
    expect(await subject.env()).toContain(`RAKAZO_IMAGE_TAG_PREVIOUS=sha-${older}\n`);
    expect(await subject.env()).toContain(`RAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${cachedOlder}\n`);
    expect(subject.state.images[cachedOlder]).toBeDefined();
    expect(subject.state.images[obsolete]).toBeUndefined();
    const rollback = await subject.app.request("/rollback", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(rollback.json()).resolves.toMatchObject({ ok: true });
    expect(subject.state.computer).toBe(`${computerImage}:${cachedOlder}`);
    expect(subject.state.versions.worker).toBe(older);
  });

  it("continues cleanup when Docker protects an image used by a container", async () => {
    const busy = `${cachePrefix}${"3".repeat(64)}`;
    const obsolete = `${cachePrefix}${"4".repeat(64)}`;
    const removed: string[] = [];
    const config = resolveUpdaterConfig({
      RAKAZO_DEPLOY_DIR: "/tmp",
      RAKAZO_UPDATER_TOKEN: token,
      COMPOSE_PROJECT_NAME: "cache-test",
    });
    const run: UpdaterCommandRunner = async (_command, args) => {
      if (args[1] === "ls")
        return { ok: true, exitCode: 0, stdout: `${busy}\n${obsolete}`, output: "" };
      removed.push(args[2] ?? "");
      const ok = args[2] !== `${computerImage}:${busy}`;
      return { ok, exitCode: ok ? 0 : 1, stdout: "", output: ok ? "" : "image is in use" };
    };
    await expect(pruneComputerCache(config, "", run)).rejects.toThrow(busy);
    expect(removed).toEqual([`${computerImage}:${busy}`, `${computerImage}:${obsolete}`]);
  });

  it("removes obsolete cache tags after success while preserving rollback and ordinary tags", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=latest\n`,
      older,
      true,
    );
    const obsolete = `${cachePrefix}${"3".repeat(64)}`;
    subject.state.images[obsolete] = `sha256:${"3".repeat(64)}`;
    subject.state.images[`cached-other-project-${"5".repeat(64)}`] = `sha256:${"5".repeat(64)}`;
    subject.state.images["operator-backup"] = `sha256:${"4".repeat(64)}`;
    subject.state.computer = `${computerImage}:latest`;
    subject.state.failTarget = true;
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(false);
    expect(subject.state.images[obsolete]).toBeDefined();
    subject.state.failTarget = false;
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
    expect(subject.state.images[obsolete]).toBeUndefined();
    expect(subject.state.images[cachedOlder]).toBeDefined();
    expect(subject.state.images["operator-backup"]).toBeDefined();
    expect(subject.state.images[`cached-other-project-${"5".repeat(64)}`]).toBeDefined();
    expect(subject.state.images.latest).toBeDefined();
    expect(subject.calls.filter(({ args }) => args[1] === "rm").map(({ args }) => args)).toEqual([
      ["image", "rm", `${computerImage}:${obsolete}`],
    ]);
  });

  it("refuses an update before changing pins when the previous computer cannot be cached", async () => {
    const env = `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=latest\n`;
    const subject = await fixture(env, older, true);
    subject.state.computer = `${computerImage}:latest`;
    delete subject.state.images.latest;
    await expect(subject.app.applyScheduledUpdate()).rejects.toThrow(
      "Could not cache the previous computer image",
    );
    expect(await subject.env()).toBe(env);
    expect(subject.calls.some(({ args }) => args.includes("pull") || args.includes("up"))).toBe(
      false,
    );
  });

  it("retains the previous computer bytes when latest moves before rollback", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=latest\n`,
      older,
      true,
    );
    subject.state.computer = `${computerImage}:latest`;
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
    expect(await subject.env()).toContain(`RAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${cachedOlder}\n`);
    subject.state.images.latest = `sha256:${"2".repeat(64)}`;
    const pulled = subject.calls.filter(({ args }) => args.includes("pull")).length;
    const response = await subject.app.request("/rollback", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(response.json()).resolves.toMatchObject({ ok: true, toTag: `sha-${older}` });
    expect(subject.state.computer).toBe(`${computerImage}:${cachedOlder}`);
    expect(subject.state.versions.worker).toBe(older);
    expect(subject.state.images[cachedOlder]).toBe(`sha256:${"1".repeat(64)}`);
    expect(await subject.env()).toContain(`RAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${cachedNewer}\n`);
    const redo = await subject.app.request("/rollback", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(redo.json()).resolves.toMatchObject({ ok: true, toTag: `sha-${newer}` });
    expect(subject.state.computer).toBe(`${computerImage}:${cachedNewer}`);
    expect(subject.state.images[cachedNewer]).toBe(`sha256:${"2".repeat(64)}`);
    expect(subject.calls.filter(({ args }) => args.includes("pull"))).toHaveLength(pulled);
  });
});
