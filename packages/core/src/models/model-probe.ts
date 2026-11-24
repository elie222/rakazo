import type { CompatibleEndpointPreset, ModelApiProtocol, ModelHeaderRow } from "@rakazo/contracts";
import {
  ModelHeaderRowsSchema,
  modelHeadersInput,
  normalizeOpenAiCompatibleBaseUrl,
  savedCompatibleEndpointMatches,
} from "@rakazo/contracts";

export const MODEL_DISCOVERY_DELAY_MS = 450;

export function isUnlistedCompatibleModel(modelId: string, models: readonly string[]): boolean {
  const id = modelId.trim();
  return Boolean(id && models.length && !models.includes(id));
}

/** A key can survive an edit only when it still targets the same endpoint. */
export function sameCompatibleModelEndpoint(previous: string, next: string): boolean {
  if (previous.trim() === next.trim()) return true;
  try {
    return savedCompatibleEndpointMatches(next, normalizeOpenAiCompatibleBaseUrl(previous));
  } catch {
    return false;
  }
}

/** Once the endpoint has enough information, schedule discovery for this exact configuration. */
export function compatibleModelDiscovery(input: {
  baseUrl: string;
  apiKey: string;
  apiProtocol: ModelApiProtocol;
  headerRows: ModelHeaderRow[] | null;
  preset?: CompatibleEndpointPreset;
  credential?: { id: string; hasKey: boolean; baseUrl?: string };
}) {
  const { preset, credential, headerRows, apiProtocol } = input;
  if (headerRows !== null && !ModelHeaderRowsSchema.safeParse(headerRows).success) return null;
  const apiKey = preset?.publicModels ? undefined : input.apiKey.trim() || undefined;
  const saved = savedCompatibleEndpointMatches(input.baseUrl, credential?.baseUrl)
    ? credential
    : undefined;
  if (preset && !preset.publicModels && !apiKey && !saved?.hasKey) return null;
  try {
    return {
      baseUrl: normalizeOpenAiCompatibleBaseUrl(input.baseUrl),
      apiKey,
      apiProtocol,
      headers: modelHeadersInput(headerRows),
      credentialId: preset?.publicModels ? undefined : saved?.id,
    };
  } catch {
    return null;
  }
}

export type ModelProbeState = {
  models: string[];
  baseUrl: string | null;
  probing: boolean;
};

export const initialModelProbeState: ModelProbeState = {
  models: [],
  baseUrl: null,
  probing: false,
};

/** Keep only the latest probe, including when its connection changes or its screen closes. */
export function createModelProbe(onChange: (state: ModelProbeState) => void) {
  let revision = 0;
  return {
    invalidate() {
      revision += 1;
    },
    reset() {
      revision += 1;
      onChange(initialModelProbeState);
    },
    async probe(options: {
      baseUrl: string;
      apiKey: string;
      request: (input: { baseUrl: string; apiKey?: string }) => Promise<{ models: string[] }>;
      onSuccess: (models: string[]) => void;
      onError: (error: unknown) => void;
    }) {
      const baseUrl = options.baseUrl.trim();
      if (!baseUrl) return;
      const requestRevision = ++revision;
      onChange({ models: [], baseUrl: null, probing: true });
      try {
        const { models } = await options.request({
          baseUrl,
          apiKey: options.apiKey.trim() || undefined,
        });
        if (requestRevision !== revision) return;
        onChange({ models, baseUrl, probing: false });
        options.onSuccess(models);
      } catch (error) {
        if (requestRevision !== revision) return;
        onChange(initialModelProbeState);
        options.onError(error);
      }
    },
  };
}
