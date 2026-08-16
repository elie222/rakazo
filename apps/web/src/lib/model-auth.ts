import { rpc } from "./rpc";

export type ModelCatalogEntry = {
  provider: string;
  providerName?: string;
  id: string;
  label: string;
  billing: string;
  auth?: "api-key" | "oauth" | "both";
  oauthLabel?: string;
  subscription?: boolean;
  signIn?: "device-code";
};

export type ModelCredential = {
  id: string;
  provider: string;
  label: string;
  hasKey: boolean;
  isDefault: boolean;
};

export function providerHint(entry: ModelCatalogEntry) {
  if (entry.signIn === "device-code") {
    if (entry.provider === "openai-codex") return "ChatGPT Plus/Pro";
    if (entry.provider === "github-copilot") return "Copilot";
    if (entry.provider === "xai") return "SuperGrok / key";
    return "Sign in";
  }
  if (entry.auth === "oauth") return "Skip or deploy key";
  return "API key";
}

type CompleteOAuthResult = Awaited<ReturnType<typeof rpc.models.completeOAuth>>;
type ConnectedOAuthResult = Extract<CompleteOAuthResult, { status: "connected" }>;

export async function waitForModelOAuth(loginId: string): Promise<ConnectedOAuthResult> {
  for (let i = 0; i < 180; i += 1) {
    const result = await rpc.models.completeOAuth({ loginId });
    if (result.status === "connected") return result;
    if (result.status === "error") throw new Error(result.error);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("Sign-in timed out. Try again.");
}
