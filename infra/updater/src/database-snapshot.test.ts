import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerUpdateRun } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { SNAPSHOT_DIRECTORY, snapshotDatabase, withSnapshotStep } from "./database-snapshot.js";
import type { UpdaterCommandRunner } from "./index.js";
import { createUpdaterApp } from "./index.js";
import { resolveUpdaterConfig } from "./updater-logic.js";

const token = "fake-review-updater-token-000000000000";
const authorized = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const targetCommit = "2".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function deployment(snapshots: string | undefined) {
  const deployDir = await mkdtemp(path.join(os.tmpdir(), "rakazo-snapshot-test-"));
  temporaryDirectories.push(deployDir);
  await writeFile(
    path.join(deployDir, ".env"),
    "RAKAZO_IMAGE_TAG=v1.0.0\nRAKAZO_IMAGE_TAG_PREVIOUS=v0.9.0\n",
  );
  return {
    deployDir,
    snapshots: path.join(deployDir, SNAPSHOT_DIRECTORY),
    config: resolveUpdaterConfig({
      RAKAZO_DEPLOY_DIR: deployDir,
      RAKAZO_UPDATER_TOKEN: token,
      RAKAZO_UPDATE_DATABASE_SNAPSHOTS: snapshots,
    }),
  };
}

function ok(output = "") {
  return { ok: true, exitCode: 0, stdout: output, output };
}

function failed(output: string) {
  return { ok: false, exitCode: 1, stdout: "", output };
}

/** A Docker that dumps, copies the dump out of the container, and recreates. */
function fakeDocker(options: { failDump?: boolean; failCopy?: boolean; failUp?: boolean } = {}) {
  const calls: string[][] = [];
  const run: UpdaterCommandRunner = async (command, args) => {
    if (command === "git") return ok(`${targetCommit}\trefs/tags/v1.1.0\n`);
    calls.push(args);
    if (args.includes("exec") && args.includes("sh")) {
      return options.failDump ? failed("pg_dump: error: connection failed") : ok();
    }
    if (args.includes("cp")) {
      if (options.failCopy) return failed("no space left on device");
      await writeFile(args.at(-1) as string, "fake custom-format dump");
      return ok();
    }
    if (args.includes("up") && options.failUp) return failed("api did not become healthy");
    return ok();
  };
  // Image caching and cleanup also call Docker; only the update's own order is asserted.
  return { calls, run, kinds: () => calls.map(kind).filter((name) => name !== "other") };
}

function kind(args: string[]) {
  if (args[0] !== "compose") return "other";
  for (const name of ["pull", "cp", "up"]) if (args.includes(name)) return name;
  if (args.includes("exec")) return args.includes("sh") ? "dump" : "clean";
  return "other";
}

async function apply(subject: ReturnType<typeof createUpdaterApp>) {
  const response = await subject.request("/apply", {
    method: "POST",
    headers: authorized,
    body: JSON.stringify({ repoUrl: "https://github.com/elie222/rakazo", branch: "main" }),
  });
  return (await response.json()) as ServerUpdateRun;
}

describe("database snapshot setting", () => {
  it("takes no snapshot unless an operator asks for some", async () => {
    const fixture = await deployment(undefined);
    expect(fixture.config.databaseSnapshots).toBe(0);
    const docker = fakeDocker();
    const record = await apply(createUpdaterApp(fixture.config, { run: docker.run }));
    expect(record.steps.map((step) => step.id)).toEqual(["pull", "recreate"]);
    expect(docker.kinds().filter((name) => name === "dump" || name === "cp")).toEqual([]);
    await expect(stat(fixture.snapshots)).rejects.toThrow();
  });

  it("rejects a count that is not a whole number from 0 to 30", () => {
    const base = { RAKAZO_DEPLOY_DIR: "/srv/rakazo", RAKAZO_UPDATER_TOKEN: token };
    for (const value of ["true", "-1", "1.5", "31"]) {
      expect(() =>
        resolveUpdaterConfig({ ...base, RAKAZO_UPDATE_DATABASE_SNAPSHOTS: value }),
      ).toThrow(/RAKAZO_UPDATE_DATABASE_SNAPSHOTS/);
    }
    expect(
      resolveUpdaterConfig({ ...base, RAKAZO_UPDATE_DATABASE_SNAPSHOTS: "30" }).databaseSnapshots,
    ).toBe(30);
  });

  it("places the snapshot directly before the recreate, and nowhere without one", () => {
    const step = (id: string) => ({ id, label: id, command: "docker", args: [] });
    expect(
      withSnapshotStep([step("pull"), step("recreate")], true).map((entry) => entry.id),
    ).toEqual(["pull", "snapshot", "recreate"]);
    expect(withSnapshotStep([step("pull")], true).map((entry) => entry.id)).toEqual(["pull"]);
  });
});

describe("snapshot before an update", () => {
  it("saves a private dump named for the outgoing release before recreating anything", async () => {
    const fixture = await deployment("2");
    const docker = fakeDocker();
    const record = await apply(createUpdaterApp(fixture.config, { run: docker.run }));
    expect(record).toMatchObject({ ok: true, fromTag: "v1.0.0" });
    expect(record.steps.map((step) => step.id)).toEqual(["pull", "snapshot", "recreate"]);
    expect(docker.kinds()).toEqual(["pull", "dump", "cp", "clean", "up"]);

    const dump = docker.calls.find((args) => args.includes("sh")) ?? [];
    expect(dump.slice(dump.indexOf("exec"), dump.indexOf("sh") + 2)).toEqual([
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
    ]);
    expect(dump.at(-1)).toContain('pg_dump --format=custom -U "$POSTGRES_USER"');
    // Restoring must bring back the migrations' revocations, so neither is stripped.
    expect(dump.at(-1)).not.toMatch(/--no-(owner|privileges)/);
    expect(dump.at(-1)).toContain("pg_restore --list");
    expect(dump.slice(0, 3)).toEqual(["compose", "-p", fixture.config.projectName]);

    const files = await readdir(fixture.snapshots);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}T\d{6}Z-v1\.0\.0\.dump$/);
    const saved = path.join(fixture.snapshots, files[0] as string);
    expect(await readFile(saved, "utf8")).toBe("fake custom-format dump");
    expect((await stat(saved)).mode & 0o777).toBe(0o600);
    expect(record.steps[1]?.output).toContain(files[0]);
  });

  it.each([{ failDump: true }, { failCopy: true }])(
    "stops before the recreate when the snapshot fails: %j",
    async (failure) => {
      const fixture = await deployment("1");
      const docker = fakeDocker(failure);
      const record = await apply(createUpdaterApp(fixture.config, { run: docker.run }));
      expect(record).toMatchObject({ ok: false, error: "Snapshot the database failed." });
      expect(record.steps.map((step) => step.id)).toEqual(["pull", "snapshot"]);
      expect(record.restartAdvice).toMatch(/No service was recreated/);
      expect(docker.kinds()).not.toContain("up");
      // The container's copy is removed whether or not the dump got that far.
      expect(docker.kinds().at(-1)).toBe("clean");
      expect(await readdir(fixture.snapshots)).toEqual([]);
      expect(await readFile(path.join(fixture.deployDir, ".env"), "utf8")).toContain(
        "RAKAZO_IMAGE_TAG=v1.0.0",
      );
    },
  );

  it("keeps the snapshot when the recreate then fails and the previous image is restored", async () => {
    const fixture = await deployment("1");
    const docker = fakeDocker({ failUp: true });
    const record = await apply(createUpdaterApp(fixture.config, { run: docker.run }));
    expect(record.ok).toBe(false);
    expect(record.steps.map((step) => step.id)).toEqual([
      "pull",
      "snapshot",
      "recreate",
      "recover",
    ]);
    expect(docker.kinds().filter((name) => name === "dump")).toHaveLength(1);
    expect(await readdir(fixture.snapshots)).toHaveLength(1);
  });

  it("takes no snapshot on a rollback, which may need the one it has", async () => {
    const fixture = await deployment("1");
    const docker = fakeDocker();
    const subject = createUpdaterApp(fixture.config, { run: docker.run });
    const response = await subject.request("/rollback", { method: "POST", headers: authorized });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record.steps.map((step) => step.id)).toEqual(["recreate"]);
    expect(docker.kinds()).not.toContain("dump");
  });
});

describe("snapshot retention", () => {
  it("keeps a retried update's first snapshot, the one from before its migrations", async () => {
    const fixture = await deployment("1");
    const target = {
      composeFiles: fixture.config.composeFiles,
      projectName: fixture.config.projectName,
    };
    await mkdir(fixture.snapshots, { recursive: true });
    await writeFile(path.join(fixture.snapshots, "20260101T000000Z-v0.9.0.dump"), "older release");
    // Four attempts at the same update, as a schedule retrying a failing recreate would make.
    for (const day of ["02", "03", "04", "05"]) {
      const result = await snapshotDatabase(
        fixture.config,
        target,
        "sha-v1.0.0-build",
        fakeDocker().run,
        new Date(`2026-01-${day}T00:00:00Z`),
      );
      expect(result.ok).toBe(true);
    }
    expect((await readdir(fixture.snapshots)).sort()).toEqual([
      "20260102T000000Z-sha-v1.0.0-build.dump",
      "20260105T000000Z-sha-v1.0.0-build.dump",
    ]);
  });

  it("keeps the newest files and leaves anything it did not name", async () => {
    const fixture = await deployment("2");
    await mkdir(fixture.snapshots, { recursive: true });
    for (const name of [
      "20260101T000000Z-v0.8.0.dump",
      "20260102T000000Z-v0.9.0.dump",
      "20260103T000000Z-v0.9.1.dump",
      "notes.txt",
    ]) {
      await writeFile(path.join(fixture.snapshots, name), "kept or pruned");
    }
    const docker = fakeDocker();
    const result = await snapshotDatabase(
      fixture.config,
      { composeFiles: fixture.config.composeFiles, projectName: fixture.config.projectName },
      "v1.0.0",
      docker.run,
      new Date("2026-01-04T05:06:07.890Z"),
    );
    expect(result.ok).toBe(true);
    expect((await readdir(fixture.snapshots)).sort()).toEqual([
      "20260103T000000Z-v0.9.1.dump",
      "20260104T050607Z-v1.0.0.dump",
      "notes.txt",
    ]);
  });
});
