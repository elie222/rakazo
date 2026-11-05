import { Axiom } from "@axiomhq/js";
import { guardedFlush, guardedWrite, reportSinkError } from "./sink-guard.js";
import type { LogEvent, LogSink } from "./types.js";

// Loaded only when AXIOM_TOKEN and AXIOM_DATASET are set (axiom.ts), so installs without
// the vendor never load its SDK.

export interface AxiomIngestClient {
  ingest(dataset: string, events: object[]): void;
  flush(): Promise<void>;
}

export interface AxiomSinkOptions {
  dataset: string;
  token?: string;
  edge?: string;
  edgeUrl?: string;
  client?: AxiomIngestClient;
}

export function createAxiomSink(options: AxiomSinkOptions): LogSink {
  const client =
    options.client ??
    new Axiom({
      token: options.token ?? "",
      ...(options.edge ? { edge: options.edge } : {}),
      ...(options.edgeUrl ? { edgeUrl: options.edgeUrl } : {}),
      onError: reportSinkError,
    });
  const dataset = options.dataset;
  return {
    write(event: LogEvent) {
      guardedWrite(() => {
        client.ingest(dataset, [event]);
      });
    },
    flush() {
      return guardedFlush(() => client.flush());
    },
  };
}
