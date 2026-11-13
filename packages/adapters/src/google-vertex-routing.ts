import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelConnectInput } from "@rakazo/contracts";
import { modelRoutingId } from "@rakazo/contracts";

type ProjectRouting = { projectId?: string; region?: string };

/** Keep legacy key-only connections working; explicit routing must be complete and path-safe. */
export function vertexRoutingForConnect(
  input: Pick<ModelConnectInput, "provider" | "projectId" | "region">,
  previous?: ProjectRouting,
): ProjectRouting | undefined {
  if (input.provider !== "google-vertex") return undefined;
  const projectId = input.projectId ?? previous?.projectId;
  const region = input.region ?? previous?.region;
  if (projectId === undefined && region === undefined) return undefined;
  if (!modelRoutingId(projectId) || !modelRoutingId(region)) {
    throw new Error("Enter a valid project ID and region.");
  }
  return { projectId: projectId?.trim(), region: region?.trim() };
}

export function withVertexRouting<T extends Model<Api>>(model: T, config: ProjectRouting): T {
  if (model.provider !== "google-vertex") return model;
  const routing = vertexRoutingForConnect({ provider: model.provider, ...config });
  if (!routing) return model;
  // Pi's Vertex adapter treats a versioned custom URL as a collection root. The SDK
  // appends publishers/google/models/<id> while retaining API-key authentication.
  const host =
    routing.region === "global"
      ? "aiplatform.googleapis.com"
      : `${routing.region}-aiplatform.googleapis.com`;
  return {
    ...model,
    baseUrl: `https://${host}/v1/projects/${routing.projectId}/locations/${routing.region}`,
  };
}
