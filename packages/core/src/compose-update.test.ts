import { describe, expect, it } from "vitest";
import {
  chooseUpdateStrategy,
  commitImageTag,
  compareReleaseTags,
  composePullArgv,
  composeUpArgv,
  composeUpdatePlan,
  DEFAULT_IMAGE_TAG,
  forkImageTag,
  imageRef,
  isValidImageName,
  isValidImageTag,
  OFFICIAL_SERVER_IMAGE,
  parseLsRemoteTags,
  parseReleaseTag,
  RECREATED_SERVICES,
  resolveExecutionMode,
  rollbackTarget,
  selectLatestReleaseTag,
  upsertEnvAssignments,
  validateUpdateRequest,
} from "./compose-update.js";

const target = {
  composeFile: "/srv/rakazo/infra/compose/docker-compose.prod.yml",
  envFiles: ["/srv/rakazo/.env"],
};

describe("image references", () => {
  it("accepts the tags the publish workflow produces", () => {
    expect(isValidImageTag("latest")).toBe(true);
    expect(isValidImageTag("v1.2.3")).toBe(true);
    expect(isValidImageTag("sha-0123456")).toBe(true);
    expect(isValidImageTag("local-0123456789ab")).toBe(true);
  });

  it("rejects tags that could become a second argument or a shell fragment", () => {
    expect(isValidImageTag("")).toBe(false);
    expect(isValidImageTag("-rm")).toBe(false);
    expect(isValidImageTag(".hidden")).toBe(false);
    expect(isValidImageTag("v1 v2")).toBe(false);
    expect(isValidImageTag("v1;rm -rf /")).toBe(false);
    expect(isValidImageTag("v1\nv2")).toBe(false);
    expect(isValidImageTag("v1/../../etc")).toBe(false);
    expect(isValidImageTag(`v${"1".repeat(200)}`)).toBe(false);
  });

  it("accepts registry paths with a host and rejects anything else", () => {
    expect(isValidImageName(OFFICIAL_SERVER_IMAGE)).toBe(true);
    expect(isValidImageName("ghcr.io:5000/owner/app")).toBe(true);
    expect(isValidImageName("rakazo/app")).toBe(true);
    expect(isValidImageName("Ghcr.io/owner/app")).toBe(false);
    expect(isValidImageName("owner/app:tag")).toBe(false);
    expect(isValidImageName("owner/../app")).toBe(false);
    expect(isValidImageName("")).toBe(false);
  });

  it("refuses to assemble a reference it could not validate", () => {
    expect(imageRef(OFFICIAL_SERVER_IMAGE, "v1.0.0")).toBe(`${OFFICIAL_SERVER_IMAGE}:v1.0.0`);
    expect(() => imageRef(OFFICIAL_SERVER_IMAGE, "-rm")).toThrow(/image tag/);
    expect(() => imageRef("BAD NAME", DEFAULT_IMAGE_TAG)).toThrow(/image name/);
  });

  it("derives local and per-commit tags from a resolved commit only", () => {
    expect(forkImageTag("0123456789abcdef0123456789abcdef01234567")).toBe("local-0123456789ab");
    expect(commitImageTag("0123456789abcdef0123456789abcdef01234567")).toBe("sha-0123456");
    expect(() => forkImageTag("HEAD")).toThrow(/commit/);
    expect(() => commitImageTag("")).toThrow(/commit/);
  });
});

describe("release tag resolution", () => {
  it("parses semver release tags and rejects other tag shapes", () => {
    expect(parseReleaseTag("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseReleaseTag("v1.2.3-rc.1")).toMatchObject({ prerelease: "rc.1" });
    expect(parseReleaseTag("1.2.3")).toBeNull();
    expect(parseReleaseTag("v1.2")).toBeNull();
    expect(parseReleaseTag("latest")).toBeNull();
  });

  it("orders releases numerically rather than lexically", () => {
    const a = parseReleaseTag("v0.9.0");
    const b = parseReleaseTag("v0.10.0");
    expect(a && b && compareReleaseTags(a, b)).toBeLessThan(0);
    const rc = parseReleaseTag("v1.0.0-rc.1");
    const release = parseReleaseTag("v1.0.0");
    expect(rc && release && compareReleaseTags(rc, release)).toBeLessThan(0);
  });

  it("reads ls-remote output, collapsing peeled refs", () => {
    const stdout = [
      "9f1c\trefs/tags/v0.1.0",
      "9f1c\trefs/tags/v0.1.0^{}",
      "aa02\trefs/tags/v0.2.0",
      "bb03\trefs/heads/main",
      "cc04\trefs/tags/",
      "",
    ].join("\n");
    expect(parseLsRemoteTags(stdout)).toEqual(["v0.1.0", "v0.2.0"]);
  });

  it("drops ls-remote tags that would not be usable as image tags", () => {
    expect(parseLsRemoteTags("aa\trefs/tags/-dangerous\nbb\trefs/tags/v1.0.0")).toEqual(["v1.0.0"]);
  });

  it("picks the newest stable release and never a pre-release", () => {
    expect(selectLatestReleaseTag(["v0.1.0", "v0.10.2", "v0.9.9"])).toBe("v0.10.2");
    expect(selectLatestReleaseTag(["v1.0.0", "v1.1.0-rc.3"])).toBe("v1.0.0");
    expect(selectLatestReleaseTag(["v2.0.0-rc.1"])).toBeNull();
    expect(selectLatestReleaseTag(["main", "latest"])).toBeNull();
    expect(selectLatestReleaseTag([])).toBeNull();
  });
});

describe("strategy and mode selection", () => {
  it("pulls for the official repository and builds for a fork", () => {
    expect(chooseUpdateStrategy({ official: true }).strategy).toBe("pull");
    expect(chooseUpdateStrategy({ official: false }).strategy).toBe("build");
    expect(chooseUpdateStrategy({ official: false }).reason).toMatch(/minutes/);
  });

  it("prefers the sidecar, falls back to a checkout, and reports when neither exists", () => {
    expect(resolveExecutionMode({ hasUpdater: true, hasCheckout: true })).toEqual({
      mode: "sidecar",
      reason: null,
    });
    expect(resolveExecutionMode({ hasUpdater: false, hasCheckout: true }).mode).toBe("checkout");
    const none = resolveExecutionMode({ hasUpdater: false, hasCheckout: false });
    expect(none.mode).toBe("unavailable");
    expect(none.reason).toMatch(/updater/);
  });

  it("reports unavailable when self-update is switched off, whatever else is present", () => {
    const off = resolveExecutionMode({ hasUpdater: true, disabled: true });
    expect(off.mode).toBe("unavailable");
    expect(off.reason).toMatch(/switched off/);
  });
});

describe("compose argv construction", () => {
  it("passes the compose file and env files as separate arguments", () => {
    expect(composePullArgv(target)).toEqual({
      command: "docker",
      args: [
        "compose",
        "--env-file",
        "/srv/rakazo/.env",
        "--file",
        target.composeFile,
        "pull",
        "api",
        "worker",
        "web",
      ],
    });
  });

  it("recreates detached, and only builds when asked to", () => {
    expect(composeUpArgv(target).args).toContain("--detach");
    expect(composeUpArgv(target).args).not.toContain("--build");
    expect(composeUpArgv(target, { build: true }).args).toContain("--build");
  });

  it("never recreates the updater, which is the process running the update", () => {
    expect(RECREATED_SERVICES).not.toContain("updater");
    for (const invocation of [composeUpArgv(target), composePullArgv(target)]) {
      expect(invocation.args).not.toContain("updater");
      expect(invocation.args).not.toContain("postgres");
    }
  });

  it("names the services explicitly so a bare up cannot sweep the whole project", () => {
    const args = composeUpArgv(target).args;
    expect(args.slice(-3)).toEqual(["api", "worker", "web"]);
  });
});

describe("update plans", () => {
  it("pulls then recreates on the official path, with no migration step", () => {
    const steps = composeUpdatePlan({ strategy: "pull", target });
    expect(steps.map((step) => step.id)).toEqual(["pull", "recreate"]);
    expect(steps.some((step) => step.id === "migrate")).toBe(false);
  });

  it("fetches, fast-forwards, then builds on the fork path", () => {
    const steps = composeUpdatePlan({
      strategy: "build",
      target,
      repoUrl: "https://github.com/someone/rakazo",
      branch: "trunk",
      repointRemote: true,
    });
    expect(steps.map((step) => step.id)).toEqual([
      "remote",
      "fetch",
      "checkout",
      "merge",
      "recreate",
    ]);
    const merge = steps.find((step) => step.id === "merge");
    expect(merge?.args).toEqual(["merge", "--ff-only", "origin/trunk"]);
    expect(steps.at(-1)?.args).toContain("--build");
  });

  it("leaves the remote alone when the checkout already points at the chosen repository", () => {
    const steps = composeUpdatePlan({
      strategy: "build",
      target,
      branch: "main",
      repointRemote: false,
    });
    expect(steps.map((step) => step.id)).toEqual(["fetch", "checkout", "merge", "recreate"]);
  });

  it("keeps the repository URL in argv rather than in any compose input", () => {
    const repoUrl = "https://github.com/someone/rakazo";
    const steps = composeUpdatePlan({
      strategy: "build",
      target,
      repoUrl,
      branch: "main",
      repointRemote: true,
    });
    const remote = steps.find((step) => step.id === "remote");
    expect(remote?.args).toEqual(["remote", "set-url", "origin", repoUrl]);
    const recreate = steps.find((step) => step.id === "recreate");
    expect(recreate?.args.some((arg) => arg.includes(repoUrl))).toBe(false);
  });
});

describe("rollback", () => {
  it("targets the tag that was running before the last update", () => {
    expect(rollbackTarget({ currentTag: "v1.1.0", previousTag: "v1.0.0" })).toEqual({
      tag: "v1.0.0",
    });
  });

  it("refuses when there is nothing recorded, nothing usable, or nothing to change", () => {
    expect(rollbackTarget({ currentTag: "v1.1.0", previousTag: null })).toEqual({
      error: expect.stringMatching(/nothing to roll back/),
    });
    expect(rollbackTarget({ currentTag: "v1.1.0", previousTag: "-rm" })).toEqual({
      error: expect.stringMatching(/not a usable tag/),
    });
    expect(rollbackTarget({ currentTag: "v1.0.0", previousTag: "v1.0.0" })).toEqual({
      error: expect.stringMatching(/already running/),
    });
  });
});

describe("managed env assignments", () => {
  it("replaces a managed key in place and leaves everything else alone", () => {
    const contents = [
      "# deployment",
      "POSTGRES_PASSWORD=secret",
      "RAKAZO_IMAGE_TAG=v1.0.0",
      "",
    ].join("\n");
    expect(upsertEnvAssignments(contents, { RAKAZO_IMAGE_TAG: "v1.1.0" })).toBe(
      ["# deployment", "POSTGRES_PASSWORD=secret", "RAKAZO_IMAGE_TAG=v1.1.0", ""].join("\n"),
    );
  });

  it("appends keys that are not present yet", () => {
    const result = upsertEnvAssignments("POSTGRES_PASSWORD=secret\n", {
      RAKAZO_IMAGE_TAG: "v1.1.0",
      RAKAZO_IMAGE_TAG_PREVIOUS: "v1.0.0",
    });
    expect(result.split("\n")).toEqual([
      "POSTGRES_PASSWORD=secret",
      "",
      "RAKAZO_IMAGE_TAG=v1.1.0",
      "RAKAZO_IMAGE_TAG_PREVIOUS=v1.0.0",
      "",
    ]);
  });

  it("keeps the file's existing line endings", () => {
    const result = upsertEnvAssignments("A=1\r\nRAKAZO_IMAGE_TAG=v1.0.0\r\n", {
      RAKAZO_IMAGE_TAG: "v2.0.0",
    });
    expect(result).toBe("A=1\r\nRAKAZO_IMAGE_TAG=v2.0.0\r\n");
  });

  it("refuses values that would inject a second assignment or a compose expression", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal is the hostile input under test
    for (const value of ["v1\nEVIL=1", "v1 v2", "$(id)", "v1;rm -rf /", "${OTHER}"]) {
      expect(() => upsertEnvAssignments("", { RAKAZO_IMAGE_TAG: value })).toThrow(/Refusing/);
    }
  });

  it("refuses keys outside the managed shape", () => {
    expect(() => upsertEnvAssignments("", { "a b": "1" })).toThrow(/Refusing/);
  });
});

describe("sidecar boundary validation", () => {
  it("normalizes a request the API already validated", () => {
    expect(
      validateUpdateRequest({ repoUrl: "https://github.com/elie222/rakazo.git", branch: " main " }),
    ).toEqual({
      request: {
        repoUrl: "https://github.com/elie222/rakazo.git",
        branch: "main",
        official: true,
      },
    });
  });

  it("marks a fork as unofficial so the sidecar picks the build path", () => {
    const result = validateUpdateRequest({
      repoUrl: "https://github.com/someone/rakazo",
      branch: "main",
    });
    expect(result).toEqual({
      request: {
        repoUrl: "https://github.com/someone/rakazo",
        branch: "main",
        official: false,
      },
    });
  });

  it("re-rejects everything the API would have rejected", () => {
    const cases: Array<{ repoUrl?: unknown; branch?: unknown }> = [
      { repoUrl: "http://github.com/a/b", branch: "main" },
      { repoUrl: "file:///etc/passwd", branch: "main" },
      { repoUrl: "https://user:pw@github.com/a/b", branch: "main" },
      { repoUrl: "https://github.com/a/b?x=1", branch: "main" },
      { repoUrl: "https://github.com/../etc", branch: "main" },
      { repoUrl: "--upload-pack=id", branch: "main" },
      { repoUrl: "https://github.com/a/b\nrm", branch: "main" },
      { repoUrl: "https://github.com/a/b", branch: "--exec=id" },
      { repoUrl: "https://github.com/a/b", branch: "main..evil" },
      { repoUrl: "https://github.com/a/b", branch: "main\tid" },
      { repoUrl: 42, branch: "main" },
      { repoUrl: "https://github.com/a/b", branch: null },
    ];
    for (const input of cases) {
      const result = validateUpdateRequest(input);
      expect("error" in result, JSON.stringify(input)).toBe(true);
    }
  });
});
