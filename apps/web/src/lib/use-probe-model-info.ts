import type { OpenAiCompatibleModelInfo } from "@rakazo/contracts";
import { useCallback, useRef, useState } from "react";

type InfoById = ReadonlyMap<string, OpenAiCompatibleModelInfo>;
const NONE: InfoById = new Map();

/**
 * Per-model capabilities from the latest "Find models" probe. Only the newest probe counts, and
 * `clear` (a probe reset) drops them with the model list. `infoRef` is current inside the probe's
 * success callback; `infoById` is the render copy for list hints.
 */
export function useProbeModelInfo() {
  const [infoById, setInfoById] = useState<InfoById>(NONE);
  const infoRef = useRef<InfoById>(NONE);
  const tokenRef = useRef(0);
  const clear = useCallback(() => {
    tokenRef.current += 1;
    infoRef.current = NONE;
    setInfoById(NONE);
  }, []);
  /** Passes the probe response through, remembering its `details` unless a newer probe began. */
  const record = useCallback(
    async <R extends { details?: OpenAiCompatibleModelInfo[] }>(
      request: Promise<R>,
    ): Promise<R> => {
      const token = ++tokenRef.current;
      infoRef.current = NONE;
      setInfoById(NONE);
      const result = await request;
      if (token === tokenRef.current) {
        const next: InfoById = new Map((result.details ?? []).map((info) => [info.id, info]));
        infoRef.current = next;
        setInfoById(next);
      }
      return result;
    },
    [],
  );
  return { infoById, infoRef, record, clear };
}
