import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ConnectionSetupError } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_PROVIDER_ID } from "./cli-models/claude-code/provider-id.js";
import { resolveDeploymentModel } from "./deployment-model.js";
import type { ModelProviderDefinition } from "./model-provider-registry.js";
import { modelProviders } from "./model-provider-registry.js";
import {
  catalogModelServesAgents,
  isRecommendedCatalogModel,
  listPiCatalog,
  verifyCatalogProviderApiKey,
} from "./pi-models.js";
import { loadProviderOAuth } from "./pi-oauth.js";

type ProviderId = keyof typeof modelProviders;
type KeyCheckedProvider = {
  [K in ProviderId]: (typeof modelProviders)[K] extends { keyCheck: object } ? K : never;
}[ProviderId];

/** Providers the model registry does not list, because Rakazo runs them itself. */
const outsideCatalog: readonly string[] = [CLAUDE_CODE_PROVIDER_ID];

/** How each provider answers a key it rejects, offline. */
const rejections = {
  openrouter: () => new Response("{}", { status: 401 }),
  deepseek: () => new Response("{}", { status: 403 }),
  google: () =>
    new Response(JSON.stringify({ error: { details: [{ reason: "API_KEY_INVALID" }] } }), {
      status: 400,
    }),
} satisfies Record<KeyCheckedProvider, () => Response>;

const entries = Object.entries(modelProviders) as [ProviderId, ModelProviderDefinition][];
const catalog = listPiCatalog();

function catalogIds(provider: string) {
  return catalog.filter((entry) => entry.provider === provider).map((entry) => entry.id);
}

/** Hosts the bundled model registry sends this provider's requests to, read apart from Rakazo's own entry. */
function catalogHosts(provider: string) {
  const models = builtinModels()
    .getProviders()
    .find((entry) => entry.id === provider)
    ?.getModels();
  return new Set(
    (models ?? []).flatMap((model) => (model.baseUrl ? [new URL(model.baseUrl).host] : [])),
  );
}

describe.each(entries)("%s model provider", (id, definition) => {
  it("is a provider the model registry lists, or one Rakazo runs itself", () => {
    expect(catalogIds(id).length > 0 || outsideCatalog.includes(id)).toBe(true);
  });

  if (definition.displayName) {
    it("keeps its display name in the catalog", () => {
      const names = new Set(
        catalog.filter((entry) => entry.provider === id).map((entry) => entry.providerName),
      );
      expect([...names]).toEqual([definition.displayName]);
    });
  }

  if (definition.recommendedModel) {
    const recommended = definition.recommendedModel;
    it("recommends one catalog model agents can run", () => {
      expect(catalogIds(id)).toContain(recommended);
      expect(catalogModelServesAgents({ provider: id, id: recommended })).toBe(true);
      expect(
        catalog.filter((entry) => entry.provider === id && entry.recommended).map((e) => e.id),
      ).toEqual([recommended]);
      expect(isRecommendedCatalogModel(id, recommended)).toBe(true);
    });
  }

  if (definition.unservedModels) {
    const unserved = definition.unservedModels;
    it("keeps the models it refuses out of agent runs", () => {
      for (const model of unserved) {
        expect(catalogModelServesAgents({ provider: id, id: model })).toBe(false);
      }
    });
  }

  if (definition.deployment) {
    const { keyEnv, defaultModel } = definition.deployment;
    it("runs a catalog model agents can run as the deployment default", () => {
      expect(catalogIds(id)).toContain(defaultModel);
      expect(catalogModelServesAgents({ provider: id, id: defaultModel })).toBe(true);
    });

    it("runs the deployment default from its own key alone", () => {
      const model = resolveDeploymentModel({ PI_DEFAULT_PROVIDER: id, [keyEnv]: "test-key" });
      expect(model).toMatchObject({ provider: id, model: defaultModel, key: "test-key" });
      expect(model.configured).toBe(true);
      expect(resolveDeploymentModel({ PI_DEFAULT_PROVIDER: id }).configured).toBe(false);
    });
  }

  if (definition.signIn) {
    it("offers sign-in only where the model registry has it", () => {
      expect(loadProviderOAuth(id)).toBeDefined();
    });
  }

  if (definition.keyCheck) {
    const check = definition.keyCheck;
    const rejection = rejections[id as KeyCheckedProvider];
    const verify = (answer: () => Promise<Response>) => {
      const sent: Request[] = [];
      const fetchImpl = (async (url: string, init: RequestInit) => {
        sent.push(new Request(url, init));
        return answer();
      }) as typeof fetch;
      return {
        sent,
        result: verifyCatalogProviderApiKey({ provider: id, apiKey: " test-key " }, fetchImpl),
      };
    };

    it("checks keys on a host the catalog sends this provider's requests to", () => {
      expect(new URL(check.url).protocol).toBe("https:");
      expect([...catalogHosts(id)]).toContain(new URL(check.url).host);
    });

    it("refuses a key the provider rejects, sending it only to its own endpoint", async () => {
      const { sent, result } = verify(async () => rejection());
      await expect(result).rejects.toBeInstanceOf(ConnectionSetupError);
      expect(sent.map((request) => request.url)).toEqual([check.url]);
      expect([...sent[0]!.headers.values()].some((value) => value.includes("test-key"))).toBe(true);
    });

    it("accepts a key the provider answers for, and one it cannot reach", async () => {
      await expect(verify(async () => new Response("{}")).result).resolves.toBeUndefined();
      await expect(
        verify(async () => new Response("{}", { status: 500 })).result,
      ).resolves.toBeUndefined();
      await expect(
        verify(async () => {
          throw new TypeError("network down");
        }).result,
      ).resolves.toBeUndefined();
    });
  }
});
