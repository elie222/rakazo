import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deferred } from "@rakazo/core/test-async";
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
    imageOverrides: {} as Record<string, string>,
    usedComputerTags: new Set<string>(),
    usedAppTags: new Set<string>(),
    appImages: {
      [`sha-${older}`]: `sha256:${"1".repeat(64)}`,
      [`sha-${newer}`]: `sha256:${"2".repeat(64)}`,
    } as Record<string, string>,
    otherComputerRefs: [] as string[],
    otherProjects: [] as string[],
    botContainers: false,
    computer: `${computerImage}:sha-${older}`,
    images: {
      [`sha-${older}`]: `sha256:${"1".repeat(64)}`,
      [`sha-${newer}`]: `sha256:${"2".repeat(64)}`,
      latest: `sha256:${"1".repeat(64)}`,
    } as Record<string, string>,
    unavailableComputer: false,
    failTarget: false,
    pausePull: false,
    pullStarted: deferred<void>(),
    continuePull: deferred<void>(),
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
      if (args.at(-1) === '{{.Label "com.docker.compose.project"}}\t{{.Label "rakazo.managed"}}')
        return ok(
          `${[
            `${config.projectName}\t`,
            ...state.otherProjects.map((project) => `${project}\t`),
            ...(state.botContainers ? ["\ttrue"] : []),
          ].join("\n")}\n`,
        );
      const ancestor = args.find((arg) => arg.startsWith("ancestor="));
      if (ancestor) {
        const tag = ancestor.split(":").at(-1) ?? "";
        const app = ancestor.startsWith(`ancestor=${appImage}:`);
        const used = app
          ? state.usedAppTags.has(tag) ||
            Object.entries(state.versions).some(
              ([service, commit]) =>
                (state.imageOverrides[service] ?? `sha256:${commit[0]?.repeat(64)}`) ===
                state.appImages[tag],
            )
          : state.usedComputerTags.has(tag);
        return ok(used ? "e".repeat(12) : "");
      }
      if (!args.some((arg) => arg.startsWith("label=com.docker.compose.project=")))
        return ok(
          [
            ids.supervisor,
            ...state.otherComputerRefs.map((_ref, index) => (index + 5).toString(16).repeat(12)),
          ].join("\n"),
        );
      const service = args
        .find((arg) => arg.startsWith("label=com.docker.compose.service="))
        ?.split("=")
        .at(-1);
      if (!service || !(service in ids)) throw new Error("Unexpected runtime lookup");
      return ok(state.versions[service] ? ids[service as keyof typeof ids] : "");
    }
    if (args[0] === "exec" || args[0] === "inspect") {
      const service = Object.keys(ids).find((name) => ids[name as keyof typeof ids] === args[1]);
      if (!service) {
        const index = state.otherComputerRefs.findIndex(
          (_ref, index) => args[1] === (index + 5).toString(16).repeat(12),
        );
        if (index >= 0) return ok(state.otherComputerRefs[index]);
        throw new Error("Unexpected container");
      }
      if (args[0] === "inspect")
        return ok(
          state.imageOverrides[service] ?? `sha256:${state.versions[service]?.[0]?.repeat(64)}`,
        );
      return ok(args.at(-1) === "process.env.GIT_SHA" ? state.versions[service] : state.computer);
    }
    if (args[0] === "image" && args[1] === "ls")
      return ok(Object.keys(args[2] === appImage ? state.appImages : state.images).join("\n"));
    if (args[0] === "image" && args[1] === "rm") {
      for (const ref of args.slice(2)) {
        const images = ref.startsWith(`${appImage}:`) ? state.appImages : state.images;
        delete images[ref.split(":").at(-1) ?? ""];
      }
      return ok();
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const tag = args[2]?.split(":").at(-1) ?? "";
      const image = args[2]?.startsWith(`${appImage}:`) ? appImage : computerImage;
      const images = image === appImage ? state.appImages : state.images;
      if (!images[tag]) return failed("image unavailable");
      if (args.at(-1) === "{{json .RepoTags}}")
        return ok(
          JSON.stringify(
            Object.keys(images)
              .filter((name) => images[name] === images[tag])
              .map((name) => `${image}:${name}`),
          ),
        );
      return ok(images[tag]);
    }
    if (args[0] === "image" && args[1] === "tag") {
      const image = args[3]?.startsWith(`${appImage}:`) ? appImage : computerImage;
      const images = image === appImage ? state.appImages : state.images;
      images[args[3]?.slice(image.length + 1) ?? ""] = args[2] ?? "";
      return ok();
    }
    if (args[0] === "pull") {
      const tag = args[1]?.slice(appImage.length + 1) ?? "";
      if (!/^sha-[0-9a-f]{40}$/.test(tag)) throw new Error("Unexpected baseline pull");
      state.appImages[tag] = `sha256:${tag[4]?.repeat(64)}`;
      return ok();
    }
    if (args.includes("pull")) {
      if (state.pausePull) {
        state.pullStarted.resolve();
        await state.continuePull.promise;
      }
      if (computers && state.unavailableComputer)
        return failed("computer commit image is not published yet");
      if (computers) state.images[`sha-${newer}`] = `sha256:${"2".repeat(64)}`;
      return ok();
    }
    if (args.includes("up")) {
      if (
        state.failTarget &&
        options.env?.RAKAZO_IMAGE_TAG === `sha-${newer}` &&
        (!computers || options.env?.RAKAZO_COMPUTER_IMAGE_TAG === `sha-${newer}`)
      )
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
    setEnv: (contents: string) => writeFile(envFile, contents),
  };
}

describe("scheduled release state and recovery", () => {
  it.each(["RAKAZO_IMAGE", "RAKAZO_COMPUTER_IMAGE"])(
    "refuses a live %s mirror edit before any command",
    async (key) => {
      const subject = await fixture(`RAKAZO_IMAGE_TAG=sha-${older}\n`, older, true);
      await subject.setEnv(`${await subject.env()}${key}=registry.example.com/mirror/image\n`);
      await expect(subject.app.applyScheduledUpdate()).rejects.toThrow(
        "official stable image repositories",
      );
      expect(subject.calls).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "freezes official repositories across a mid-update env edit (failure=%s)",
    async (failure) => {
      const subject = await fixture(
        `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=sha-${older}\n`,
        older,
        true,
      );
      subject.state.pausePull = true;
      subject.state.failTarget = failure;
      const pending = subject.app.applyScheduledUpdate();
      await subject.state.pullStarted.promise;
      await subject.setEnv(
        `${await subject.env()}RAKAZO_IMAGE=registry.example.com/mirror/app\nRAKAZO_COMPUTER_IMAGE=registry.example.com/mirror/computer\n`,
      );
      subject.state.continuePull.resolve();
      expect((await pending).ok).toBe(!failure);
      const commands = subject.calls.filter(
        ({ args }) => args.includes("pull") || args.includes("up"),
      );
      expect(commands.length).toBe(failure ? 3 : 2);
      for (const { env } of commands) {
        expect(env.RAKAZO_IMAGE).toBe(appImage);
        expect(env.RAKAZO_COMPUTER_IMAGE).toBe(computerImage);
      }
      expect(
        subject.calls.some(({ args }) =>
          args.some((arg) => arg.includes("registry.example.com/mirror")),
        ),
      ).toBe(false);
      await expect(subject.app.applyScheduledUpdate()).rejects.toThrow(
        "official stable image repositories",
      );
    },
  );

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
      args: ["image", "inspect", `${appImage}:sha-${newer}`, "--format", "{{.Id}}"],
      env: {},
    });
  });

  it("does not retag another stack's published image with source-built bytes", async () => {
    const env = `RAKAZO_IMAGE_TAG=latest\n`;
    const subject = await fixture(env, older);
    for (const service of Object.keys(subject.state.versions))
      subject.state.imageOverrides[service] = `sha256:${"f".repeat(64)}`;
    await expect(subject.app.applyScheduledUpdate()).rejects.toThrow("differs from the published");
    expect(subject.state.appImages[`sha-${older}`]).toBe(`sha256:${"1".repeat(64)}`);
    expect(await subject.env()).toBe(env);
    expect(
      subject.calls.some(
        ({ args }) => args[1] === "tag" || args.includes("pull") || args.includes("up"),
      ),
    ).toBe(false);
  });

  it("caches a missing baseline from the registry before updating a latest install", async () => {
    const subject = await fixture("RAKAZO_IMAGE_TAG=latest\n", older);
    delete subject.state.appImages[`sha-${older}`];
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
    expect(
      subject.calls.some(
        ({ args }) => args[0] === "pull" && args[1] === `${appImage}:sha-${older}`,
      ),
    ).toBe(true);
    expect(
      subject.calls.some(
        ({ args }) =>
          args[0] === "image" && args[1] === "tag" && args[3]?.startsWith(`${appImage}:`),
      ),
    ).toBe(false);
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
    expect(await subject.env()).toContain("RAKAZO_COMPUTER_IMAGE_TAG=latest\n");
  });

  it("preserves registry pins across a failed pull and failed updates with recovery", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=latest\n`,
      older,
      true,
    );
    subject.state.computer = `${computerImage}:latest`;
    subject.state.unavailableComputer = true;
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(false);
    expect(subject.calls.some(({ args }) => args.includes("up"))).toBe(false);
    expect(await subject.env()).toContain("RAKAZO_COMPUTER_IMAGE_TAG=latest\n");
    subject.state.unavailableComputer = false;
    subject.state.failTarget = true;
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(false);
    expect(subject.state.computer).toBe(`${computerImage}:${cachedOlder}`);
    expect(await subject.env()).toContain("RAKAZO_COMPUTER_IMAGE_TAG=latest\n");
    // A later check observes the local recovery tag in the supervisor, not the .env pin.
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(false);
    expect(await subject.env()).toContain("RAKAZO_COMPUTER_IMAGE_TAG=latest\n");
    expect(
      subject.calls.filter(({ args }) => args.includes("up")).at(-1)?.env.RAKAZO_COMPUTER_IMAGE_TAG,
    ).toBe(cachedOlder);
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

  it.each([older, newer])(
    "repulls a missing pinned computer while the app is on %s",
    async (commit) => {
      const subject = await fixture(
        `RAKAZO_IMAGE_TAG=sha-${commit}\nRAKAZO_IMAGE_TAG_PREVIOUS=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=sha-${newer}\nRAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${cachedOlder}\n`,
        commit,
        true,
      );
      subject.state.computer = `${computerImage}:sha-${newer}`;
      subject.state.images[cachedOlder] = `sha256:${"1".repeat(64)}`;
      delete subject.state.images[`sha-${newer}`];
      subject.state.unavailableComputer = true;
      expect((await subject.app.applyScheduledUpdate()).ok).toBe(false);
      expect(subject.calls.some(({ args }) => args.includes("up"))).toBe(false);
      subject.state.unavailableComputer = false;
      expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
      expect(subject.state.images[`sha-${newer}`]).toBeDefined();
      expect(await subject.env()).toContain(`RAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${cachedOlder}\n`);
      const pulls = subject.calls.filter(({ args }) => args.includes("pull")).length;
      await subject.app.applyScheduledUpdate();
      expect(subject.calls.filter(({ args }) => args.includes("pull"))).toHaveLength(pulls);
    },
  );

  it.each([older, newer])(
    "does not recover different image bytes sharing commit %s",
    async (commit) => {
      const subject = await fixture(
        `RAKAZO_IMAGE_TAG=sha-${commit}\nRAKAZO_IMAGE_TAG_PREVIOUS=sha-${older}\n`,
        commit,
      );
      subject.state.imageOverrides.worker = `sha256:${"f".repeat(64)}`;
      subject.state.failTarget = true;
      const result = await subject.app.applyScheduledUpdate();
      expect(result.ok).toBe(false);
      expect(result.restart).toBe("manual");
      expect(subject.calls.filter(({ args }) => args.includes("up"))).toHaveLength(1);
      expect(result.steps.some((step) => step.id === "recover")).toBe(false);
      expect(subject.state.versions.worker).toBe(commit);
    },
  );

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

  it("refuses rollback before changing pins when the previous computer cache was deleted", async () => {
    const env = `RAKAZO_IMAGE_TAG=sha-${newer}\nRAKAZO_IMAGE_TAG_PREVIOUS=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=sha-${newer}\nRAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${cachedOlder}\n`;
    const subject = await fixture(env, newer, true);
    const response = await subject.app.request("/rollback", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("previous computer image is not cached locally");
    expect(await subject.env()).toBe(env);
    expect(subject.calls.some(({ args }) => args.includes("up") || args.includes("pull"))).toBe(
      false,
    );
  });

  it("recovers the prior app when its computer already selected the target release", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=sha-${newer}\n`,
      older,
      true,
    );
    subject.state.computer = `${computerImage}:sha-${newer}`;
    subject.state.failTarget = true;
    const result = await subject.app.applyScheduledUpdate();
    expect(result.ok).toBe(false);
    expect(result.steps.some((step) => step.id === "recover" && step.ok)).toBe(true);
    expect(subject.state.versions.api).toBe(older);
    expect(subject.state.computer).toBe(`${computerImage}:${cachedNewer}`);
  });

  it("refuses a manual repository migration before changing deployment pins", async () => {
    const env = `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE=registry.example.com/mirror/computer\n`;
    const subject = await fixture(env, older, true);
    const response = await subject.app.request("/apply", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/elie222/rakazo", branch: "main" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Could not verify the supervisor's computer image");
    expect(await subject.env()).toBe(env);
    expect(subject.calls.some(({ args }) => args.includes("up") || args.includes("pull"))).toBe(
      false,
    );
  });

  it("captures the complete prior pairing when only the application image changes", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=sha-${newer}\nRAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${cachedOlder}\n`,
      older,
      true,
    );
    subject.state.computer = `${computerImage}:sha-${newer}`;
    subject.state.images[cachedOlder] = `sha256:${"1".repeat(64)}`;
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
    expect(await subject.env()).toContain(`RAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${cachedNewer}\n`);
    expect(subject.state.images[cachedNewer]).toBeDefined();
    const rollback = await subject.app.request("/rollback", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(rollback.json()).resolves.toMatchObject({ ok: true });
    expect(subject.state.versions.worker).toBe(older);
    expect(subject.state.computer).toBe(`${computerImage}:${cachedNewer}`);
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
      if (args[0] === "ps") return { ok: true, exitCode: 0, stdout: "", output: "" };
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
    subject.state.botContainers = true;
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

  it("retains a project cache tag selected by another supervisor even when pins omit it", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=latest\n`,
      older,
      true,
    );
    subject.state.computer = `${computerImage}:latest`;
    const selected = `${cachePrefix}${"3".repeat(64)}`;
    subject.state.images[selected] = `sha256:${"3".repeat(64)}`;
    subject.state.otherComputerRefs.push(`${computerImage}:${selected}`);
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
    expect(subject.state.images[selected]).toBeDefined();
    expect(
      subject.calls.some(
        ({ args }) => args[1] === "rm" && args.includes(`${computerImage}:${selected}`),
      ),
    ).toBe(false);
  });

  it.each([
    [false, "other-stack"],
    [true, "other-stack"],
    [true, ""],
  ] as const)(
    "skips shared-host image cleanup (managed computer=%s, foreign project=%s)",
    async (computers, project) => {
      const subject = await fixture(`RAKAZO_IMAGE_TAG=sha-${older}\n`, older, computers);
      const otherRollback = `sha-${"3".repeat(40)}`;
      subject.state.appImages[otherRollback] = `sha256:${"3".repeat(64)}`;
      const cache = `${cachePrefix}${"3".repeat(64)}`;
      subject.state.images[cache] = `sha256:${"3".repeat(64)}`;
      subject.state.botContainers = true;
      subject.state.otherProjects.push(project);
      expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
      expect(subject.state.appImages[otherRollback]).toBeDefined();
      expect(subject.state.images[cache]).toBeDefined();
      expect(subject.calls.some(({ args }) => args[1] === "rm")).toBe(false);
    },
  );

  it("pins an already-current latest computer once so later latest pulls cannot move its selection", async () => {
    const subject = await fixture(
      "RAKAZO_IMAGE_TAG=latest\nRAKAZO_COMPUTER_IMAGE_TAG=latest\n",
      newer,
      true,
    );
    subject.state.computer = `${computerImage}:latest`;
    subject.state.images.latest = `sha256:${"2".repeat(64)}`;
    expect(subject.state.images.latest).toBe(subject.state.images[`sha-${newer}`]);
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
    expect(subject.state.computer).toBe(`${computerImage}:sha-${newer}`);
    const recreations = subject.calls.filter(({ args }) => args.includes("up")).length;
    expect(recreations).toBe(1);
    subject.state.images.latest = `sha256:${"3".repeat(64)}`;
    expect((await subject.app.applyScheduledUpdate()).restart).toBe("not-required");
    expect(subject.state.computer).toBe(`${computerImage}:sha-${newer}`);
    expect(subject.calls.filter(({ args }) => args.includes("up"))).toHaveLength(recreations);
  });

  it("cleans app releases without a managed computer while preserving rollback and used images", async () => {
    const subject = await fixture(`RAKAZO_IMAGE_TAG=sha-${older}\n`, older);
    const obsolete = `sha-${"3".repeat(40)}`;
    const used = `sha-${"4".repeat(40)}`;
    const aliased = `sha-${"5".repeat(40)}`;
    for (const [index, tag] of [obsolete, used, aliased].entries())
      subject.state.appImages[tag] = `sha256:${(index + 3).toString().repeat(64)}`;
    subject.state.usedAppTags.add(used);
    subject.state.appImages["operator-backup"] = subject.state.appImages[aliased] ?? "";
    subject.state.failTarget = true;
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(false);
    expect(subject.state.appImages[obsolete]).toBeDefined();
    subject.state.failTarget = false;
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
    expect(subject.state.appImages[obsolete]).toBeUndefined();
    for (const tag of [used, aliased, `sha-${older}`, `sha-${newer}`])
      expect(subject.state.appImages[tag]).toBeDefined();
    expect(subject.calls.some(({ args }) => args[1] === "ls" && args[2] === computerImage)).toBe(
      false,
    );
  });

  it("reclaims obsolete release images while retaining current, previous, used and shared images", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=latest\n`,
      older,
      true,
    );
    subject.state.computer = `${computerImage}:latest`;
    const obsolete = `sha-${"3".repeat(40)}`;
    const used = `sha-${"4".repeat(40)}`;
    const shared = `sha-${"5".repeat(40)}`;
    const alias = `sha-${"6".repeat(40)}`;
    for (const [index, tag] of [obsolete, used, shared, alias].entries())
      subject.state.images[tag] = `sha256:${(index + 3).toString().repeat(64)}`;
    subject.state.images[`${cachePrefix}${"3".repeat(64)}`] = subject.state.images[obsolete] ?? "";
    const secondObsolete = `sha-${"7".repeat(40)}`;
    subject.state.images[secondObsolete] = subject.state.images[obsolete] ?? "";
    subject.state.images["operator-backup"] = subject.state.images[alias] ?? "";
    subject.state.usedComputerTags.add(used);
    subject.state.otherComputerRefs.push(`${computerImage}:${shared}`);
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
    expect(subject.state.images[obsolete]).toBeUndefined();
    expect(subject.state.images[secondObsolete]).toBeUndefined();
    for (const tag of [used, shared, alias, cachedOlder, `sha-${newer}`])
      expect(subject.state.images[tag]).toBeDefined();
    expect(
      subject.calls.filter(({ args }) => args[1] === "rm").map(({ args }) => args[2]),
    ).toContain(`${computerImage}:${obsolete}`);
  });

  it("repairs a missing previous computer without inventing rollback history", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=latest\n`,
      older,
      true,
    );
    subject.state.computer = `${computerImage}:latest`;
    delete subject.state.images.latest;
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(true);
    expect(subject.state.computer).toBe(`${computerImage}:sha-${newer}`);
    expect(await subject.env()).toContain("RAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=\n");
    const rollback = await subject.app.request("/rollback", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rollback.status).toBe(400);
  });

  it("recovers a failed manual computer-only repair from the actual cached computer", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${newer}\nRAKAZO_COMPUTER_IMAGE_TAG=latest\n`,
      newer,
      true,
    );
    subject.state.failTarget = true;
    const result = await subject.app.request("/apply", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/elie222/rakazo", branch: "main" }),
    });
    await expect(result.json()).resolves.toMatchObject({ ok: false, restart: "not-required" });
    expect(
      subject.calls
        .filter(({ args }) => args.includes("up"))
        .map(({ env }) => env.RAKAZO_COMPUTER_IMAGE_TAG),
    ).toEqual([`sha-${newer}`, cachedOlder]);
    expect(subject.state.computer).toBe(`${computerImage}:${cachedOlder}`);
  });

  it("manual updates snapshot the recovered supervisor image after the original tag moves", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_COMPUTER_IMAGE_TAG=latest\n`,
      older,
      true,
    );
    subject.state.computer = `${computerImage}:latest`;
    subject.state.failTarget = true;
    expect((await subject.app.applyScheduledUpdate()).ok).toBe(false);
    expect(subject.state.computer).toBe(`${computerImage}:${cachedOlder}`);
    subject.state.images.latest = `sha256:${"2".repeat(64)}`;
    subject.state.failTarget = false;
    const applied = await subject.app.request("/apply", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/elie222/rakazo", branch: "main" }),
    });
    await expect(applied.json()).resolves.toMatchObject({ ok: true });
    expect(await subject.env()).toContain(`RAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${cachedOlder}\n`);
    const rollback = await subject.app.request("/rollback", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(rollback.json()).resolves.toMatchObject({ ok: true });
    expect(subject.state.computer).toBe(`${computerImage}:${cachedOlder}`);
  });

  it("manual rollback captures the recovered image even if its configured tag moved", async () => {
    const subject = await fixture(
      `RAKAZO_IMAGE_TAG=sha-${older}\nRAKAZO_IMAGE_TAG_PREVIOUS=sha-${newer}\nRAKAZO_COMPUTER_IMAGE_TAG=latest\nRAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=${cachedNewer}\n`,
      older,
      true,
    );
    subject.state.computer = `${computerImage}:${cachedOlder}`;
    subject.state.images[cachedOlder] = `sha256:${"1".repeat(64)}`;
    subject.state.images[cachedNewer] = `sha256:${"2".repeat(64)}`;
    subject.state.images.latest = `sha256:${"2".repeat(64)}`;
    for (const expected of [newer, older]) {
      const rollback = await subject.app.request("/rollback", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      await expect(rollback.json()).resolves.toMatchObject({ ok: true });
      expect(subject.state.versions.worker).toBe(expected);
    }
    expect(subject.state.computer).toBe(`${computerImage}:${cachedOlder}`);
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
