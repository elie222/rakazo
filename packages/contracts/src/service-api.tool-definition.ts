import type { ServiceRouteDefinition, ServiceRouteId } from "./service-api.js";
import { SERVICE_ROUTES, serviceJsonSchema } from "./service-api.js";

export type ServiceTool = {
  name: ServiceRouteId;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Top-level arguments that travel in the query string. */
  queryKeys: string[];
};

/**
 * The same routes as tools for a Model Context Protocol client. Path and query parameters are
 * top-level arguments and the JSON body is `body`, so a tool is exactly its route.
 */
export function buildServiceTools(): ServiceTool[] {
  return (Object.entries(SERVICE_ROUTES) as Array<[ServiceRouteId, ServiceRouteDefinition]>)
    .filter(([id, definition]) => !definition.stream && id !== "openapi")
    .map(([name, definition]) => {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const match of definition.path.matchAll(/:([A-Za-z]+)/g)) {
        const param = match[1] as string;
        properties[param] = { type: "string" };
        required.push(param);
      }
      const query = definition.query
        ? (serviceJsonSchema(definition.query, "input") as {
            properties?: Record<string, unknown>;
            required?: string[];
          })
        : {};
      const queryKeys = Object.keys(query.properties ?? {});
      Object.assign(properties, query.properties);
      required.push(...(query.required ?? []));
      if (definition.body) {
        properties.body = serviceJsonSchema(definition.body, "input");
        required.push("body");
      }
      if (definition.idempotency) {
        properties.idempotencyKey = {
          type: "string",
          pattern: "^[A-Za-z0-9._:-]{1,128}$",
          description:
            "Repeat the same value to retry this exact call safely. One is made up when omitted.",
        };
      }
      return {
        name,
        description: definition.summary,
        inputSchema: { type: "object", properties, required, additionalProperties: false },
        queryKeys,
      };
    });
}
