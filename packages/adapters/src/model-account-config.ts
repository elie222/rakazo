import { createHash } from "node:crypto";
import { z } from "zod";
import { parseModelSecret } from "./models/model-secret.js";
import { ResellerModelAccountProvider } from "./reseller-model-account.js";

const origin = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === "/"
  );
});
const link = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
});
const schema = z.object({
  provider: z.literal("reseller"),
  // The adapter validates this server-only HTTP(S) origin.
  origin: z.url(),
  credential: z.string().min(1),
  authorizationOrigins: z.array(origin).min(1).optional(),
  navigationOrigin: origin.default("https://home.agentone.work"),
  baseUrl: link.optional(),
  defaults: z
    .object({
      responses: z.string().min(1).max(256).optional(),
      "chat-completions": z.string().min(1).max(256).optional(),
      "anthropic-messages": z.string().min(1).max(256).optional(),
    })
    .strict()
    .default({}),
  // Accept the old connection envelope during upgrades; new deployments only need baseUrl.
  model: z.record(z.string(), z.unknown()).optional(),
});

export function configuredModelAccount(value: string | undefined) {
  if (!value?.trim()) return undefined;
  try {
    const config = schema.parse(JSON.parse(value));
    const model = parseModelSecret(
      JSON.stringify(config.model ?? { kind: "openai_compatible", baseUrl: config.baseUrl }),
    );
    if (
      model.kind !== "openai_compatible" ||
      model.apiKey ||
      config.model?.externalAccount !== undefined ||
      model.headers
    )
      throw new Error();
    const url = new URL(model.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error();

    return {
      provider: new ResellerModelAccountProvider(config),
      credentialVersion: createHash("sha256").update(config.credential).digest("hex"),
      model,
      defaults: config.defaults,
      navigationOrigin: config.navigationOrigin,
      serviceName: "TokenONE",
    };
  } catch {
    throw new Error("Invalid MODEL_ACCOUNT_CONNECTION configuration");
  }
}
