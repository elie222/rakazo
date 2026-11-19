import { createModelAccountClient } from "@rakazo/core";
import { authHeaders, currentApiBase } from "./api/api";
import { fetchServer } from "./api/server-headers";
import { currentSessionGeneration } from "./api/session";

export function modelAccountClient() {
  const base = currentApiBase();
  const generation = currentSessionGeneration();
  return createModelAccountClient(async (url, init) => {
    const headers = new Headers(await authHeaders());
    if (base !== currentApiBase() || generation !== currentSessionGeneration())
      throw new Error("Account changed");
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    headers.set("origin", "rakazo://");
    const response = await fetchServer(url, { ...init, headers }, base);
    if (base !== currentApiBase() || generation !== currentSessionGeneration())
      throw new Error("Account changed");
    return response;
  }, `${base}/api/model-account`);
}

export function modelAccountConfigQuery() {
  return {
    queryKey: ["model-account-config", currentApiBase(), currentSessionGeneration()],
    queryFn: ({ signal }: { signal: AbortSignal }) => modelAccountClient().config(signal),
  };
}
export function modelAccountStatusQuery() {
  return {
    queryKey: ["model-account-status", currentApiBase(), currentSessionGeneration()],
    queryFn: ({ signal }: { signal: AbortSignal }) => modelAccountClient().status(signal),
  };
}
