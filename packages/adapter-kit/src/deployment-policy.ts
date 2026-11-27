/** One tool call, as a deployment policy sees it before the call is approved or run. */
export interface DeploymentPolicyToolCall {
  /** The person the run acts for. */
  userId: string;
  spaceId: string;
  botId: string;
  runId: string;
  /** The tool the bot called. */
  tool: string;
  /**
   * The names approval rules match for this call: the tool, the name a connected app gives it,
   * or each action a batch tool was asked to run.
   */
  actions: readonly string[];
  /** A copy of the call's arguments. */
  args: Record<string, unknown>;
}

/** `refuse` is the sentence the bot reads in place of the tool's result. */
export interface DeploymentPolicyRefusal {
  refuse: string;
}

/**
 * Rules a deployment adds to every run, on top of the app's own. A policy can only refuse: it
 * never allows a call the app would refuse or ask a person about.
 */
export interface DeploymentPolicy {
  /** Called for every tool call. Return nothing to leave the call to the app's own checks. */
  toolCall?(
    call: DeploymentPolicyToolCall,
  ): DeploymentPolicyRefusal | undefined | Promise<DeploymentPolicyRefusal | undefined>;
}
