import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const COMPOSE = "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml";
const APP_IMAGE = "ghcr.example.test/rakazo/app:local";
// Each rolled service gains a new container, which must pass its health check before the old
// one stops; the rest of the stack is reconciled afterwards.
const rolloutSteps = (revision: string) => [
  // The image the running API uses, restored if the deploy fails.
  `${COMPOSE} ps --quiet api`,
  "docker inspect --format {{.Image}} api-old",
  `${COMPOSE} config --quiet`,
  `${COMPOSE} config`,
  `${COMPOSE} build --build-arg GIT_SHA=${revision}`,
  ...["api", "web"].flatMap((service) => [
    `${COMPOSE} ps --all --quiet ${service}`,
    `${COMPOSE} up -d --no-deps --no-recreate --scale ${service}=2 ${service}`,
    `${COMPOSE} ps --all --quiet ${service}`,
    `docker inspect --format {{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}} ${service}-new`,
    `docker stop --time 30 ${service}-old`,
    `docker rm ${service}-old`,
  ]),
  `${COMPOSE} up -d --remove-orphans`,
];
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

function rollout(commands: string[]) {
  return commands
    .map((line) => line.split(" @ ")[0] ?? line)
    .filter(
      (line) =>
        / (config|build|up|ps) /.test(`${line} `) || /^docker (inspect|stop|rm) /.test(line),
    );
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
if [[ "$*" == *" build "* && "$(cat revision.txt)" == "\${FAIL_BUILD:-}" ]]; then exit 1; fi
if [[ "$1" == info ]]; then echo /var/lib/docker; fi
if [[ "$*" == *" config" ]]; then printf "services:\\n  api:\\n    image: ${APP_IMAGE}\\n"; fi
if [[ "$1" == inspect && "$*" == *"{{.Image}}"* ]]; then
  [[ -n "\${PREVIOUS_IMAGE-sha256:previous}" ]] || exit 1
  echo "\${PREVIOUS_IMAGE-sha256:previous}"
  exit 0
fi
if [[ "$*" == *" ps --quiet api" && -z "\${FRESH:-}" ]]; then echo api-old; fi
if [[ "$*" == *" run --rm --no-deps -T --entrypoint sh postgres "* && -n "\${POSTGRES_16:-}" ]]; then
  echo upgrade
fi
if [[ "$1" == pull && -n "\${FAIL_PULL:-}" ]]; then exit 1; fi
if [[ "$*" == *" images -q" ]]; then echo sha256:running; fi
if [[ "$1" == tag && -n "\${FAIL_TAG:-}" ]]; then exit 1; fi
# One running container per rolled service; --scale adds a second until the old one is removed.
service="\${*: -1}"
if [[ "$*" == *" ps --all --quiet "* ]]; then
  [[ -z "\${FRESH:-}" ]] && echo "$service-old"
  [[ -e "$COMMAND_LOG.$service" ]] && echo "$service-new"
fi
if [[ "$*" == *" --scale "* ]]; then touch "$COMMAND_LOG.$service"; fi
if [[ "$1" == rm && "$2" == *-old ]]; then rm -f "$COMMAND_LOG.\${2%-old}"; fi
if [[ "$1" == inspect ]]; then echo "\${CONTAINER_HEALTH:-running healthy}"; fi
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
    expect(rollout(deploy.commands())).toEqual(rolloutSteps(deploy.first));
  });

  it("deploys the revision the launcher pinned even after main moves on", () => {
    const deploy = fixture();
    const pinned = commit(deploy.upstream, "pinned");
    commit(deploy.upstream, "later");
    const result = deploy.run({ RAKAZO_DEPLOY_REVISION: pinned });
    expect(result.status).toBe(0);
    expect(deploy.head()).toBe(pinned);
    expect(deploy.deployed()).toBe(pinned);
    expect(rollout(deploy.commands())).toContain(`${COMPOSE} build --build-arg GIT_SHA=${pinned}`);
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
    expect(rollout(deploy.commands())).toEqual(rolloutSteps(next));
  });

  it("keeps the previous images and prunes the rest after a healthy rollout", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    expect(deploy.run().status).toBe(0);
    const commands = deploy.commands().map((line) => line.split(" @ ")[0]);
    expect(
      commands.slice(commands.findIndex((line) => line.endsWith(" up -d --remove-orphans")) + 1),
    ).toEqual([
      "curl https://app.example.test/health",
      "docker image ls --format {{.Repository}}:{{.Tag}} rakazo-rollback",
      "docker rmi rakazo-rollback:old",
      "docker tag sha256:running rakazo-rollback:running",
      "docker image prune --force",
      "docker builder prune --force --keep-storage 8GB",
    ]);
  });

  it("trims the build cache to the configured size", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    expect(deploy.run({ RAKAZO_DEPLOY_BUILD_CACHE_GB: "3" }).status).toBe(0);
    expect(deploy.commands()).toContainEqual(
      expect.stringContaining("docker builder prune --force --keep-storage 3GB"),
    );
  });

  it("refuses a build cache size that is not a whole number before deploying", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    const result = deploy.run({ RAKAZO_DEPLOY_BUILD_CACHE_GB: "8GB" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RAKAZO_DEPLOY_BUILD_CACHE_GB must be a whole number");
    expect(deploy.commands()).toEqual([]);
    expect(deploy.head()).toBe(deploy.first);
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

  it("replaces nothing while the database still needs its upgrade to Postgres 18", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    const result = deploy.run({ POSTGRES_16: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("one-time upgrade to 18");
    expect(deploy.head()).toBe(deploy.first);
    expect(rollout(deploy.commands()).filter((line) => / (build|up) /.test(`${line} `))).toEqual(
      [],
    );
  });

  it("rolls back to the image the previous containers ran when the build fails", () => {
    const deploy = fixture();
    const broken = commit(deploy.upstream, "broken");
    const result = deploy.run({ FAIL_BUILD: "broken" });
    expect(result.status).toBe(1);
    expect(deploy.head()).toBe(deploy.first);
    const commands = deploy.commands().map((line) => line.split(" @ ")[0]);
    expect(commands.filter((line) => line.startsWith(`${COMPOSE} build`))).toEqual([
      `${COMPOSE} build --build-arg GIT_SHA=${broken}`,
    ]);
    expect(commands).toContain(`docker tag sha256:previous ${APP_IMAGE}`);
    expect(deploy.commands().at(-1)).toMatch(
      new RegExp(`up -d --remove-orphans @ ${deploy.first.slice(0, 7)}`),
    );
  });

  it("rebuilds the previous revision when the running image is unknown", () => {
    const deploy = fixture();
    const broken = commit(deploy.upstream, "broken");
    const result = deploy.run({ FAIL_BUILD: "broken", PREVIOUS_IMAGE: "" });
    expect(result.status).toBe(1);
    expect(deploy.head()).toBe(deploy.first);
    expect(
      rollout(deploy.commands()).filter((line) => line.startsWith(`${COMPOSE} build`)),
    ).toEqual([
      `${COMPOSE} build --build-arg GIT_SHA=${broken}`,
      `${COMPOSE} build --build-arg GIT_SHA=${deploy.first}`,
    ]);
  });

  describe("with published images", () => {
    const REGISTRY = "registry.example.test/rakazo/app";
    const published = (revision: string) => `${REGISTRY}:sha-${revision}`;
    const commandsOf = (deploy: ReturnType<typeof fixture>) =>
      deploy.commands().map((line) => line.split(" @ ")[0]);

    it("pulls the image published for the commit instead of building", () => {
      const deploy = fixture();
      const next = commit(deploy.upstream, "next");
      const result = deploy.run({ RAKAZO_DEPLOY_IMAGE: REGISTRY });
      expect(result.status).toBe(0);
      expect(deploy.deployed()).toBe(next);
      const commands = commandsOf(deploy);
      expect(commands.some((line) => line.startsWith(`${COMPOSE} build`))).toBe(false);
      const pull = commands.indexOf(`docker pull --quiet ${published(next)}`);
      expect(pull).toBeGreaterThan(-1);
      // Tagged as the image Compose runs, and the sha- tag dropped so they cannot pile up.
      expect(commands.slice(pull + 1, pull + 3)).toEqual([
        `docker tag ${published(next)} ${APP_IMAGE}`,
        `docker rmi ${published(next)}`,
      ]);
      expect(commands.indexOf(`${COMPOSE} up -d --remove-orphans`)).toBeGreaterThan(pull);
    });

    it("uses the GHCR image of the GitHub repository the checkout tracks by default", () => {
      const deploy = fixture();
      const next = commit(deploy.upstream, "next");
      const github = "https://github.com/Example/Rakazo.git";
      git(deploy.checkout, "remote", "set-url", "origin", github);
      // The deploy runs with HOME set to the fixture root, so fetches still reach the local upstream.
      write(
        path.join(path.dirname(deploy.checkout), ".gitconfig"),
        `[url "${deploy.upstream}"]\n\tinsteadOf = ${github}\n`,
      );
      expect(deploy.run().status).toBe(0);
      expect(commandsOf(deploy)).toContain(
        `docker pull --quiet ghcr.io/example/rakazo/app:sha-${next}`,
      );
    });

    it("builds on the host, loudly, when the image cannot be pulled", () => {
      const deploy = fixture();
      const next = commit(deploy.upstream, "next");
      const result = deploy.run({ RAKAZO_DEPLOY_IMAGE: REGISTRY, FAIL_PULL: "1" });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(`::warning::Could not pull ${published(next)}`);
      expect(deploy.deployed()).toBe(next);
      const commands = commandsOf(deploy);
      expect(commands).toContain(`${COMPOSE} build --build-arg GIT_SHA=${next}`);
      expect(commands).not.toContain(`docker tag ${published(next)} ${APP_IMAGE}`);
    });

    it("rolls back by retagging the previous image without the registry", () => {
      const deploy = fixture();
      commit(deploy.upstream, "unhealthy");
      const result = deploy.run({ RAKAZO_DEPLOY_IMAGE: REGISTRY, FAIL_HEALTH: "1" });
      expect(result.status).toBe(1);
      expect(deploy.head()).toBe(deploy.first);
      const commands = commandsOf(deploy);
      expect(commands.filter((line) => line.startsWith("docker pull"))).toHaveLength(1);
      expect(commands).toContain(`docker tag sha256:previous ${APP_IMAGE}`);
    });

    it("pulls the previous commit image to roll back when the running image is unknown", () => {
      const deploy = fixture();
      const next = commit(deploy.upstream, "unhealthy");
      const result = deploy.run({
        RAKAZO_DEPLOY_IMAGE: REGISTRY,
        FAIL_HEALTH: "1",
        PREVIOUS_IMAGE: "",
      });
      expect(result.status).toBe(1);
      const commands = commandsOf(deploy);
      expect(commands.filter((line) => line.startsWith("docker pull"))).toEqual([
        `docker pull --quiet ${published(next)}`,
        `docker pull --quiet ${published(deploy.first)}`,
      ]);
      expect(commands.some((line) => line.startsWith(`${COMPOSE} build`))).toBe(false);
    });

    it("keeps only the current and previous app images", () => {
      const deploy = fixture();
      const next = commit(deploy.upstream, "next");
      expect(deploy.run({ RAKAZO_DEPLOY_IMAGE: REGISTRY }).status).toBe(0);
      const commands = commandsOf(deploy);
      expect(commands).toContain(`docker rmi ${published(next)}`);
      expect(
        commands.slice(commands.findIndex((line) => line.endsWith(" up -d --remove-orphans")) + 1),
      ).toEqual([
        "curl https://app.example.test/health",
        "docker image ls --format {{.Repository}}:{{.Tag}} rakazo-rollback",
        "docker rmi rakazo-rollback:old",
        "docker tag sha256:running rakazo-rollback:running",
        "docker image prune --force",
        "docker builder prune --force --keep-storage 8GB",
      ]);
    });
  });

  it("starts the first containers directly when none are running", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    expect(deploy.run({ FRESH: "1" }).status).toBe(0);
    const commands = rollout(deploy.commands());
    expect(commands).toContain(`${COMPOSE} up -d --wait api`);
    expect(commands).toContain(`${COMPOSE} up -d --wait web`);
    expect(commands.some((line) => line.includes("--scale"))).toBe(false);
  });

  it("keeps the old container serving when the new one fails its health check", () => {
    const deploy = fixture();
    commit(deploy.upstream, "unhealthy");
    const result = deploy.run({ CONTAINER_HEALTH: "running unhealthy" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not become healthy");
    const commands = rollout(deploy.commands());
    expect(commands).toContain("docker rm --force api-new");
    expect(commands).not.toContain("docker stop --time 30 api-old");
    expect(deploy.head()).toBe(deploy.first);
  });

  it("accepts a running container whose revision has no health check", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    expect(deploy.run({ CONTAINER_HEALTH: "running" }).status).toBe(0);
    expect(rollout(deploy.commands())).toContain("docker stop --time 30 web-old");
  });

  it("removes a replacement that exits before it is ready", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    const result = deploy.run({ CONTAINER_HEALTH: "exited healthy" });
    expect(result.status).toBe(1);
    expect(rollout(deploy.commands())).toContain("docker rm --force api-new");
  });

  it("recreates Caddy only when its config changed", () => {
    const deploy = fixture();
    commit(deploy.upstream, "next");
    expect(deploy.run().status).toBe(0);
    expect(deploy.commands().some((line) => line.includes(" caddy"))).toBe(false);

    write(path.join(deploy.upstream, "infra/compose/Caddyfile.prod"), ":80\n");
    git(deploy.upstream, "add", "infra/compose/Caddyfile.prod");
    commit(deploy.upstream, "caddy");
    expect(deploy.run().status).toBe(0);
    expect(deploy.commands()).toContainEqual(
      expect.stringContaining(`${COMPOSE} up -d --no-deps --force-recreate caddy`),
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

describe("production deploy launcher", () => {
  it("runs the deploy script from origin/main, not the checkout", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-launcher-"));
    temporaryDirectories.push(root);
    const upstream = path.join(root, "upstream");
    const checkout = path.join(root, "checkout with spaces");
    const script = path.join("infra", "compose", "deploy-main.sh");
    mkdirSync(upstream);
    git(upstream, "init", "-q", "-b", "main");
    write(path.join(upstream, script), 'echo "stale $*"\n');
    git(upstream, "add", script);
    commit(upstream, "first");
    git(root, "clone", "-q", upstream, checkout);
    write(path.join(upstream, script), 'echo "current $0 $* $RAKAZO_DEPLOY_REVISION"\n');
    git(upstream, "add", script);
    const next = commit(upstream, "next");

    const result = spawnSync(
      "/bin/bash",
      [path.join(repoRoot, "infra/compose/deploy-launcher.sh"), "--flag"],
      {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, RAKAZO_DEPLOY_DIR: checkout },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`current rakazo-deploy-main --flag ${next}`);
  });

  function launcherRepo() {
    const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-launcher-"));
    temporaryDirectories.push(root);
    const upstream = path.join(root, "upstream");
    const checkout = path.join(root, "checkout");
    const script = path.join("infra", "compose", "deploy-main.sh");
    mkdirSync(upstream);
    git(upstream, "init", "-q", "-b", "main");
    write(path.join(upstream, script), 'echo "deploy $RAKAZO_DEPLOY_REVISION"\n');
    git(upstream, "add", script);
    const tested = commit(upstream, "tested");
    const later = commit(upstream, "merged after the green run");
    git(root, "clone", "-q", upstream, checkout);
    const launch = (command: string) =>
      spawnSync("/bin/bash", [path.join(repoRoot, "infra/compose/deploy-launcher.sh")], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          RAKAZO_DEPLOY_DIR: checkout,
          SSH_ORIGINAL_COMMAND: command,
        },
        encoding: "utf8",
        timeout: 20_000,
      });
    return { checkout, tested, later, launch };
  }

  it("deploys the commit CI tested, not a newer main", () => {
    const repo = launcherRepo();
    const result = repo.launch(`deploy-main ${repo.tested}`);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`deploy ${repo.tested}`);
  });

  it("does not roll back to an older commit than production runs", () => {
    const repo = launcherRepo();
    write(path.join(repo.checkout, ".last-deployed-revision"), `${repo.later}\n`);
    const result = repo.launch(`deploy-main ${repo.tested}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing to deploy");
    expect(result.stdout).not.toContain("deploy ");
  });

  it("refuses a commit that is not on main or not a full SHA", () => {
    const repo = launcherRepo();
    const offMain = repo.launch(`deploy-main ${"a".repeat(40)}`);
    expect(offMain.status).toBe(1);
    expect(offMain.stderr).toContain("not on main");
    const short = repo.launch("deploy-main main");
    expect(short.status).toBe(1);
    expect(short.stderr).toContain("full commit SHA");
  });

  it("refuses a relative checkout path", () => {
    const result = spawnSync(
      "/bin/bash",
      [path.join(repoRoot, "infra/compose/deploy-launcher.sh")],
      {
        env: { PATH: process.env.PATH, RAKAZO_DEPLOY_DIR: "relative" },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("absolute path");
  });
});
