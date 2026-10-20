import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function write(file: string, content: string, mode?: number) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode) chmodSync(file, mode);
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string) {
  write(path.join(cwd, "revision.txt"), `${message}\n`);
  git(cwd, "add", "revision.txt");
  git(
    cwd,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.test",
    "commit",
    "-qm",
    message,
  );
  return git(cwd, "rev-parse", "HEAD");
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-deploy-"));
  temporaryDirectories.push(root);
  const upstream = path.join(root, "upstream");
  const checkout = path.join(root, "checkout with spaces");
  const bin = path.join(root, "bin");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  const first = commit(upstream, "first");
  git(root, "clone", "-q", upstream, checkout);
  write(path.join(checkout, ".env"), "RAKAZO_HOST=app.example.test\n");
  const log = path.join(root, "commands.log");
  // Record every privileged or network command instead of running it.
  write(path.join(bin, "sudo"), '#!/bin/bash\nexec "$@"\n', 0o755);
  write(
    path.join(bin, "timeout"),
    '#!/bin/bash\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
    0o755,
  );
  write(
    path.join(bin, "docker"),
    `#!/bin/bash
echo "docker $* @ $(git rev-parse --short HEAD)" >> "$COMMAND_LOG"
if [[ "$*" == *" build" && -n "\${FAIL_BUILD:-}" ]]; then exit 1; fi
if [[ "$1" == info ]]; then echo /var/lib/docker; fi
if [[ "$*" == *" images -q" ]]; then echo sha256:running; fi
if [[ "$1" == tag && -n "\${FAIL_TAG:-}" ]]; then exit 1; fi
if [[ "$*" == "image ls "* ]]; then echo rakazo-rollback:old; fi
exit 0
`,
    0o755,
  );
  write(
    path.join(bin, "df"),
    `#!/bin/bash
echo "df $*" >> "$COMMAND_LOG"
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/fake 104857600 0 \${FREE_KB:-52428800} 0% /"
`,
    0o755,
  );
  write(
    path.join(bin, "curl"),
    `#!/bin/bash\necho "curl \${*: -1}" >> "$COMMAND_LOG"\n[[ -z "\${FAIL_HEALTH:-}" ]]\n`,
    0o755,
  );
  write(path.join(bin, "flock"), `#!/bin/bash\n[[ -z "\${LOCK_HELD:-}" ]]\n`, 0o755);
  const env = {
    PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
    HOME: root,
    COMMAND_LOG: log,
    RAKAZO_DEPLOY_DIR: checkout,
    RAKAZO_DEPLOY_HEALTH_INTERVAL: "0",
  };
  return {
    upstream,
    checkout,
    first,
    run(overrides: Record<string, string> = {}) {
      const result = spawnSync("/bin/bash", [path.join(repoRoot, "infra/compose/deploy-main.sh")], {
        cwd: root,
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(result.error).toBeUndefined();
      return result;
    },
    commands(): string[] {
      try {
        return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    head: () => git(checkout, "rev-parse", "HEAD"),
    deployed: () => readFileSync(path.join(checkout, ".last-deployed-revision"), "utf8").trim(),
  };
}

describe("production deploy script", () => {
  it("fails instead of reporting success while another deploy holds the lock", () => {
    const deploy = fixture();
    const next = commit(deploy.upstream, "next");
    const result = deploy.run({ LOCK_HELD: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holds the lock");
    expect(deploy.head()).not.toBe(next);
    expect(deploy.commands()).toEqual([]);
  });

  it("only checks health when production is already current", () => {
    const deploy = fixture();
    write(path.join(deploy.checkout, ".last-deployed-revision"), `${deploy.first}\n`);
    const result = deploy.run();
    expect(result.status).toBe(0);
    expect(deploy.commands().filter((line) => !/^(df|docker info) /.test(line))).toEqual([
      "curl https://app.example.test/health",
    ]);
  });

  it("deploys when the checkout matches but that revision was never recorded", () => {
    const deploy = fixture();
    const result = deploy.run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("already at");
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.deployed()).toBe(deploy.first);
    const docker = deploy.commands().filter((line) => / (config|build|up) /.test(`${line} `));
    expect(docker.map((line) => line.split(" @ ")[0])).toEqual([
      "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml config --quiet",
      "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml build",
      "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml up -d --remove-orphans",
    ]);
  });

  it("deploys when the recorded revision is not the checkout", () => {
    const deploy = fixture();
    write(path.join(deploy.checkout, ".last-deployed-revision"), "outdated\n");
    const result = deploy.run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("already at");
    expect(deploy.deployed()).toBe(deploy.first);
    expect(deploy.commands().some((line) => line.includes(" up -d --remove-orphans"))).toBe(true);
  });

  it("builds, starts, and records the new revision under time limits", () => {
    const deploy = fixture();
    const next = commit(deploy.upstream, "next");
    const result = deploy.run();
    expect(result.status).toBe(0);
    expect(deploy.head()).toBe(next);
    expect(deploy.deployed()).toBe(next);
    const docker = deploy.commands().filter((line) => / (config|build|up) /.test(`${line} `));
    expect(docker.map((line) => line.split(" @ ")[0])).toEqual([
      "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml config --quiet",
      "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml build",
      "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml up -d --remove-orphans",
    ]);
  });

  it("keeps the previous images and prunes the rest after a healthy rollout", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    expect(deploy.run().status).toBe(0);
    const commands = deploy.commands().map((line) => line.split(" @ ")[0]);
    expect(commands.slice(commands.findIndex((line) => line.includes(" up -d ")) + 1)).toEqual([
      "curl https://app.example.test/health",
      "docker image ls --format {{.Repository}}:{{.Tag}} rakazo-rollback",
      "docker rmi rakazo-rollback:old",
      "docker tag sha256:running rakazo-rollback:running",
      "docker image prune --force",
      "docker builder prune --all --force --filter until=24h",
    ]);
  });

  it("keeps every image when the previous ones could not be tagged", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    const result = deploy.run({ FAIL_TAG: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("skipping image prune");
    expect(deploy.commands().some((line) => line.startsWith("docker image prune"))).toBe(false);
  });

  it("rejects a threshold with a leading zero", () => {
    const deploy = fixture();
    const result = deploy.run({ RAKAZO_DEPLOY_MIN_FREE_GB: "08" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("whole number");
  });

  it("refuses to build with too little free disk", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    const result = deploy.run({ FREE_KB: String(2 * 1024 * 1024), RAKAZO_DEPLOY_MIN_FREE_GB: "5" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Only 2GB free");
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.commands().some((line) => line.includes(" build"))).toBe(false);
  });

  it("rolls back to the previous revision when the build fails", () => {
    const deploy = fixture();
    commit(deploy.upstream, "broken");
    const result = deploy.run({ FAIL_BUILD: "1" });
    expect(result.status).toBe(1);
    expect(deploy.head()).toBe(deploy.first);
    expect(deploy.commands().at(-1)).toMatch(
      new RegExp(`up -d --build --remove-orphans @ ${deploy.first.slice(0, 7)}`),
    );
  });

  it("rolls back when production never becomes healthy", () => {
    const deploy = fixture();
    commit(deploy.upstream, "unhealthy");
    const result = deploy.run({ FAIL_HEALTH: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not recover");
    expect(deploy.head()).toBe(deploy.first);
  });
});
