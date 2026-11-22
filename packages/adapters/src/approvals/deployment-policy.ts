import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DeploymentPolicy, DeploymentPolicyToolCall } from "@rakazo/adapter-kit";
import { deadlineSignal, withAbort } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

/** How long a policy may take over one call before the call is refused. */
const POLICY_TIMEOUT_MS = 5_000;
const MAX_REFUSAL_LENGTH = 500;

/** What the bot reads when the policy refuses without a sentence of its own. */
export const DEPLOYMENT_POLICY_REFUSED =
  "This deployment does not allow this call. Don't try it another way; tell the user it's blocked.";
/** What the bot reads when the policy threw, timed out or answered with something else. */
export const DEPLOYMENT_POLICY_FAILED =
  "This deployment's policy could not be checked, so the call was refused. Tell the user.";

/**
 * The policy exported by default from the module `DEPLOYMENT_POLICY_MODULE` names, or undefined
 * when it is unset. A module that cannot be loaded or exports no policy throws, so a process
 * never starts without the rules its deployment asked for.
 */
export async function loadDeploymentPolicy(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeploymentPolicy | undefined> {
  const location = env.DEPLOYMENT_POLICY_MODULE?.trim();
  if (!location) return undefined;
  const url = location.startsWith("file:") ? location : pathToFileURL(path.resolve(location)).href;
  const loaded: { default?: unknown } = await import(url);
  const policy = loaded.default;
  if (!policy || typeof policy !== "object")
    throw new Error("DEPLOYMENT_POLICY_MODULE must export a policy object by default");
  const { toolCall } = policy as { toolCall?: unknown };
  if (toolCall !== undefined && typeof toolCall !== "function")
    throw new Error("DEPLOYMENT_POLICY_MODULE: toolCall must be a function");
  return policy;
}

/**
 * The sentence a deployment's policy refuses a tool call with, or undefined when it lets the
 * call go on to the app's own checks. A policy that throws, takes too long or answers with
 * anything but a refusal or nothing refuses the call.
 */
export async function deploymentPolicyRefusal(
  policy: DeploymentPolicy | undefined,
  call: DeploymentPolicyToolCall,
  timeoutMs = POLICY_TIMEOUT_MS,
): Promise<string | undefined> {
  if (!policy?.toolCall) return undefined;
  try {
    // The policy gets its own copy, so it cannot change the arguments the call runs with.
    const asked = { ...call, actions: [...call.actions], args: structuredClone(call.args) };
    const decision: unknown = await withAbort(
      Promise.resolve().then(() => policy.toolCall?.(asked)),
      deadlineSignal(timeoutMs),
    );
    if (decision === undefined || decision === null) return undefined;
    const refuse = (decision as { refuse?: unknown }).refuse;
    if (typeof refuse !== "string") throw new TypeError("not a refusal");
    return refuse.trim().slice(0, MAX_REFUSAL_LENGTH) || DEPLOYMENT_POLICY_REFUSED;
  } catch (error) {
    // The error and the arguments can carry what the call was about, so only its kind is logged.
    getLogger().error("deployment_policy.failed", {
      runId: call.runId,
      tool: call.tool,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return DEPLOYMENT_POLICY_FAILED;
  }
}
