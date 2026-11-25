import { rpcQuery } from "../query/query";
import { ARTIFACT_DOWNLOAD_TIMEOUT_MS } from "./artifacts";

export function artifactContentRead(artifactId: string) {
  return rpcQuery("artifacts/getById", { artifactId }, undefined, {
    timeoutMs: ARTIFACT_DOWNLOAD_TIMEOUT_MS,
  });
}
