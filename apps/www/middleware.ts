import { next, rewrite } from "@vercel/functions";
import {
  AGENT_DISCOVERY_LINKS,
  getMarkdownAlternate,
  negotiateRepresentation,
} from "./src/agent-content.js";

const VARY_HEADER = "Accept, Accept-Encoding";
const APEX_ORIGIN = "https://rakazo.com";
const WWW_HOST = "www.rakazo.com";

export const config = {
  matcher: ["/((?!api|_astro|.*\\..*).*)", "/sitemap.xml"],
};

function permanentRedirect(location: string): Response {
  return new Response(null, {
    status: 301,
    headers: { Location: location },
  });
}

export default function middleware(request: Request): Response {
  const url = new URL(request.url);

  if (url.hostname.toLowerCase() === WWW_HOST) {
    const destination = new URL(`${url.pathname}${url.search}`, APEX_ORIGIN);
    return permanentRedirect(destination.toString());
  }

  if (url.pathname === "/sitemap.xml") {
    const destination = new URL(`/sitemap-index.xml${url.search}`, APEX_ORIGIN);
    return permanentRedirect(destination.toString());
  }

  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const markdownAlternate = getMarkdownAlternate(url.pathname);
  if (markdownAlternate && negotiateRepresentation(request.headers.get("accept")) === "markdown") {
    const destination = new URL(url);
    destination.pathname = markdownAlternate;
    return rewrite(destination, {
      headers: {
        "Content-Language": "en",
        "Content-Type": "text/markdown; charset=utf-8",
        Link: AGENT_DISCOVERY_LINKS,
        Vary: VARY_HEADER,
      },
    });
  }
  return next({
    headers: {
      Link: [
        AGENT_DISCOVERY_LINKS,
        ...(markdownAlternate
          ? [`<${markdownAlternate}>; rel="alternate"; type="text/markdown"`]
          : []),
      ].join(", "),
      Vary: VARY_HEADER,
    },
  });
}
