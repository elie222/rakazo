export const SCREENSHOT_MODEL_CONNECTION = {
  provider: "opencode-go",
  modelId: "glm-5.3-flash",
  apiKey: "fixture-only-model-quota-token",
};

const SCREENSHOT_QUOTA = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2030-03-17T17:00:00Z" },
    weekly: { status: "ok", percent: 54, resetsAt: "2030-03-20T12:00:00Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2030-04-01T12:00:00Z" },
  },
};

export function createScreenshotModelQuotaFetch(): typeof fetch {
  return async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://opencode.ai/zen/go/v1/usage") {
      throw new Error("Unexpected provider quota request in screenshot fixture");
    }
    return Response.json(SCREENSHOT_QUOTA);
  };
}
