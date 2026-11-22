import {
  compatibleModelDiscovery,
  createModelProbe,
  initialModelProbeState,
  MODEL_DISCOVERY_DELAY_MS,
} from "@rakazo/core";
import { useCallback, useEffect, useState } from "react";
import { useTimeout } from "./hooks.js";

type DiscoveryDraft = Parameters<typeof compatibleModelDiscovery>[0];
type DiscoveryRequest = NonNullable<ReturnType<typeof compatibleModelDiscovery>>;

/** Runs discovery for the current endpoint, including when the form reloads its draft. */
export function useCompatibleModelDiscovery(
  draft: DiscoveryDraft | null,
  options: {
    request: (input: DiscoveryRequest) => Promise<{ models: string[] }>;
    onModels: (models: string[]) => void;
    errorMessage: (error: unknown) => string;
  },
) {
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const [probeError, setProbeError] = useState<string | null>(null);
  const [resetRevision, setResetRevision] = useState(0);
  const discovery = draft && compatibleModelDiscovery(draft);

  function discoverModels() {
    if (!discovery) return;
    setProbeError(null);
    void modelProbe.probe({
      baseUrl: discovery.baseUrl,
      apiKey: discovery.apiKey ?? "",
      request: () => options.request(discovery),
      onSuccess: options.onModels,
      onError: (err) => setProbeError(options.errorMessage(err)),
    });
  }

  const resetOpenAiCompatibleProbe = useCallback(() => {
    modelProbe.reset();
    setProbeError(null);
    setResetRevision((revision) => revision + 1);
  }, [modelProbe]);

  useEffect(() => modelProbe.invalidate, [modelProbe]);
  useTimeout(
    discoverModels,
    discovery ? (draft?.preset?.publicModels ? 0 : MODEL_DISCOVERY_DELAY_MS) : null,
    JSON.stringify([resetRevision, draft?.headerRows, discovery]),
  );

  return {
    discoverModels,
    modelProbe,
    probeError,
    probeModels,
    probing,
    resetOpenAiCompatibleProbe,
  };
}
