import { INBOUND_DELIVERY_ROUTES } from "./sessionless-routes.js";

type Fetch<E> = (request: Request, env: E) => Response | Promise<Response>;

const routes = Object.keys(INBOUND_DELIVERY_ROUTES).map((key) => {
  const [method = "", path = ""] = key.split(" ");
  return { method, segments: path.split("/") };
});

/** Whether `method` and `pathname` name an inbound delivery: a webhook or a provider's event. */
export function isInboundDelivery(method: string, pathname: string): boolean {
  const segments = pathname.split("/");
  return routes.some(
    (route) =>
      (route.method === "ALL" || route.method === method) &&
      route.segments.length === segments.length &&
      route.segments.every((part, index) => {
        const given = segments[index] ?? "";
        return part.startsWith(":") ? given !== "" : part === given;
      }),
  );
}

/**
 * The app as the public ingress sees it: inbound deliveries reach it unchanged, and every other
 * request (sign-in, the API, the web app) gets a bare 404, so a public tunnel exposes nothing else.
 */
export function inboundOnly<E>(fetch: Fetch<E>): Fetch<E> {
  return (request, env) =>
    isInboundDelivery(request.method, new URL(request.url).pathname)
      ? fetch(request, env)
      : new Response("Not Found", { status: 404 });
}
