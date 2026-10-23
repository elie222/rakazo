import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowsDir = path.resolve(import.meta.dirname, "../../../.github/workflows");
const workflowText = readFileSync(path.join(workflowsDir, "publish-server-image.yml"), "utf8");
interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  uses?: string;
  "runs-on"?: string;
  permissions?: Record<string, string>;
  strategy?: { matrix?: { arch?: string[]; include?: Array<Record<string, string>> } };
}

const workflow = parse(workflowText) as {
  on: Record<string, { branches?: string[]; tags?: string[] } | null>;
  jobs: {
    validate: WorkflowJob;
    build: WorkflowJob;
    "build-depot": WorkflowJob;
    publish: WorkflowJob;
  };
};
const ci = parse(readFileSync(path.join(workflowsDir, "ci.yml"), "utf8")) as {
  jobs: Record<string, WorkflowJob>;
};

describe("server image publish workflow", () => {
  it("builds every architecture natively instead of emulating arm64", () => {
    expect(workflowText).not.toContain("setup-qemu-action");
    const build = workflow.jobs.build;
    expect(build["runs-on"]).toContain("matrix.runner");
    expect(build.strategy?.matrix?.arch).toEqual(["amd64", "arm64"]);
    const runners = Object.fromEntries(
      (build.strategy?.matrix?.include ?? [])
        .filter((entry) => entry.arch !== undefined)
        .map((entry) => [entry.arch, entry.runner]),
    );
    expect(runners).toEqual({ amd64: "ubuntu-latest", arm64: "ubuntu-24.04-arm" });
  });

  it("publishes one verified multi-arch manifest per image after both builds", () => {
    const publish = workflow.jobs.publish;
    expect(publish.needs).toEqual(["build", "build-depot"]);
    expect(publish.if).toContain("needs.build.result == 'success'");
    expect(publish.if).toContain("needs.build-depot.result == 'success'");
    expect(workflowText).toContain("push-by-digest=true");
    expect(workflowText).toContain("docker buildx imagetools create");
    expect(workflowText).toContain("for want in linux/amd64 linux/arm64");
    expect(workflowText).toContain("actions/attest-build-provenance@");
  });

  it("builds on Depot only when the repository names a project, and never for pull requests", () => {
    const depot = workflow.jobs["build-depot"];
    expect(depot.if).toBe("github.event_name != 'pull_request' && vars.DEPOT_PROJECT_ID != ''");
    expect(workflow.jobs.build.if).toBe(
      "github.event_name != 'pull_request' && vars.DEPOT_PROJECT_ID == ''",
    );
    expect(depot.permissions?.["id-token"]).toBe("write");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal workflow expression
    expect(workflowText).toContain("project: ${{ vars.DEPOT_PROJECT_ID }}");
  });

  it("checks the app image for credentials before any tag points at it", () => {
    const checks = workflowText.match(/bash infra\/compose\/check-image\.sh/g) ?? [];
    // One check per build path, both before the publish job tags the digest.
    expect(checks).toHaveLength(2);
    // GitHub's runners check each architecture on its own leg; Depot's one build checks both.
    expect(workflowText).toContain('check-image.sh "$IMAGE" "$PLATFORM"');
    expect(workflowText).toContain("for platform in linux/amd64 linux/arm64; do");
    expect(workflowText.indexOf("check-image.sh")).toBeLessThan(
      workflowText.indexOf("docker buildx imagetools create"),
    );
  });

  it("publishes main from ci.yml so the production deploy waits for its image", () => {
    expect(workflow.on.push?.branches).toBeUndefined();
    expect(workflow.on).toHaveProperty("workflow_call");
    const publish = ci.jobs["publish-server-image"];
    expect(publish?.uses).toBe("./.github/workflows/publish-server-image.yml");
    expect(publish?.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(ci.jobs["deploy-production"]?.needs).toEqual([
      "lint",
      "check",
      "build",
      "test",
      "test-integration",
      "test-postgres-upgrade",
      "test-e2e",
      "publish-server-image",
    ]);
  });

  it("keeps pull requests read-only and every action pinned to a commit", () => {
    const validate = workflow.jobs.validate;
    expect(validate.if).toBe("github.event_name == 'pull_request'");
    expect(workflow.jobs.publish.if).toContain("github.event_name != 'pull_request'");
    expect(workflowText).toContain("push: false");
    for (const match of workflowText.matchAll(/uses:\s+([^\s#]+)/g)) {
      expect(match[1], match[1]).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
