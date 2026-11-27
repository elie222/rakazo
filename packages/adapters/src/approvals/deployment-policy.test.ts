import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DeploymentPolicy, DeploymentPolicyToolCall } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEPLOYMENT_POLICY_FAILED,
  DEPLOYMENT_POLICY_REFUSED,
  deploymentPolicyRefusal,
  loadDeploymentPolicy,
} from "./deployment-policy.js";

const call: DeploymentPolicyToolCall = {
  userId: "user-1",
  spaceId: "space-1",
  botId: "bot-1",
  runId: "run-1",
  tool: "shell",
  actions: ["shell"],
  args: { command: "ls" },
};

describe("loadDeploymentPolicy", () => {
  let dir: string | undefined;
  const moduleFile = async (source: string) => {
    dir = await mkdtemp(path.join(tmpdir(), "deployment-policy-"));
    const file = path.join(dir, "policy.mjs");
    await writeFile(file, source);
    return file;
  };

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("loads nothing when no module is named", async () => {
    expect(await loadDeploymentPolicy({})).toBeUndefined();
  });

  it("loads the policy a module exports by default", async () => {
    const file = await moduleFile(
      'export default { toolCall: (call) => (call.tool === "shell" ? { refuse: "No shell here." } : undefined) };',
    );
    const policy = await loadDeploymentPolicy({ DEPLOYMENT_POLICY_MODULE: file });
    expect(await deploymentPolicyRefusal(policy, call)).toBe("No shell here.");
  });

  it.each([
    ["no default export", "export const toolCall = () => undefined;"],
    ["a toolCall that is not a function", 'export default { toolCall: "refuse" };'],
  ])("fails to load a module with %s", async (_what, source) => {
    const file = await moduleFile(source);
    await expect(loadDeploymentPolicy({ DEPLOYMENT_POLICY_MODULE: file })).rejects.toThrow(
      "DEPLOYMENT_POLICY_MODULE",
    );
  });
});

describe("deploymentPolicyRefusal", () => {
  it("lets a call through when the policy has no objection", async () => {
    expect(await deploymentPolicyRefusal({ toolCall: () => undefined }, call)).toBeUndefined();
  });

  it("uses its own sentence when the policy refuses without one", async () => {
    const policy: DeploymentPolicy = { toolCall: async () => ({ refuse: "  " }) };
    expect(await deploymentPolicyRefusal(policy, call)).toBe(DEPLOYMENT_POLICY_REFUSED);
  });

  it("refuses the call when the policy throws", async () => {
    const policy: DeploymentPolicy = {
      toolCall: () => {
        throw new Error("lookup failed");
      },
    };
    expect(await deploymentPolicyRefusal(policy, call)).toBe(DEPLOYMENT_POLICY_FAILED);
  });

  it("refuses the call when the policy does not answer in time", async () => {
    const never = deferred<undefined>();
    const policy: DeploymentPolicy = { toolCall: () => never.promise };
    expect(await deploymentPolicyRefusal(policy, call, 1)).toBe(DEPLOYMENT_POLICY_FAILED);
  });

  it("refuses the call when the policy answers late after blocking the process", async () => {
    const policy: DeploymentPolicy = {
      toolCall: () => {
        const until = performance.now() + 20;
        while (performance.now() < until);
        return undefined;
      },
    };
    expect(await deploymentPolicyRefusal(policy, call, 5)).toBe(DEPLOYMENT_POLICY_FAILED);
  });

  it("refuses the call when the policy answers with something that is not a refusal", async () => {
    const policy = { toolCall: () => ({ allow: true }) } as unknown as DeploymentPolicy;
    expect(await deploymentPolicyRefusal(policy, call)).toBe(DEPLOYMENT_POLICY_FAILED);
  });

  it("hands the policy a copy, so it cannot change the arguments the call runs with", async () => {
    const args = { command: "ls", options: { cwd: "/work" } };
    const policy: DeploymentPolicy = {
      toolCall: (seen) => {
        (seen.args.options as { cwd: string }).cwd = "/";
        return undefined;
      },
    };
    await deploymentPolicyRefusal(policy, { ...call, args });
    expect(args.options.cwd).toBe("/work");
  });
});
