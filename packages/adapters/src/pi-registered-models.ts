import type { CreateModelsOptions, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerLocalProvider } from "./pi-local-provider.js";
import { applyPiModelCompatibility } from "./pi-model-compat.js";
import { registerOllamaCloudProvider } from "./pi-ollama-cloud-provider.js";
import { registerOpenAiCompatibleCatalog } from "./pi-openai-compatible-provider.js";

/**
 * Pi's bundled catalog plus the providers Rakazo registers itself. The catalog,
 * the runtime and the vision check all read models from here so a provider
 * added in one place cannot be missing from another.
 */
export function registeredPiModels(options?: CreateModelsOptions): MutableModels {
  return registerOpenAiCompatibleCatalog(
    registerOllamaCloudProvider(
      registerLocalProvider(applyPiModelCompatibility(builtinModels(options))),
    ),
  );
}
