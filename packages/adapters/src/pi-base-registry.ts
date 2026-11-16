/**
 * The registry every entry point starts from: Pi's bundled catalogue, the local provider, the
 * compatibility pass, then the providers this repo adds. One place, because a provider that is
 * registered in the app catalogue but missing from the runtime catalogue is a model the UI offers
 * and a run cannot reach.
 */
import type { MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerCommandCodeProvider } from "./pi-commandcode-provider.js";
import { registerLocalProvider } from "./pi-local-provider.js";
import { applyPiModelCompatibility } from "./pi-model-compat.js";

export function piBaseRegistry(options?: Parameters<typeof builtinModels>[0]): MutableModels {
  return registerCommandCodeProvider(
    registerLocalProvider(applyPiModelCompatibility(builtinModels(options))),
  );
}
