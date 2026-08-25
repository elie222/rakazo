import { next } from "@vercel/functions";
import {
  getMarkdownAlternate,
  getMarkdownDocument,
  markdownResponse,
  negotiateRepresentation,
  NOT_FOUND_MARKDOWN,
} from "./src/agent-content.js";

const VARY_HEADER = "Accept, Accept-Encoding";

export const config = {
  matcher: ["/((?!api|_astro|.*\\..*).*)"],
};

export default function middleware(request: Request): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const { pathname } = new URL(request.url);
  const acceptHeader = request.headers.get("accept");
  const representation = negotiateRepresentation(acceptHeader);
  const markdown = getMarkdownDocument(pathname);
  const genericAgentNotFound =
    !markdown && (!acceptHeader?.trim() || acceptHeader.trim() === "*/*");

  if (representation === "markdown" || genericAgentNotFound) {
    return markdownResponse(
      markdown ?? NOT_FOUND_MARKDOWN,
      request.method,
      markdown ? 200 : 404,
    );
  }

  if (representation === "not-acceptable") {
    return new Response(
      request.method === "HEAD"
        ? null
        : "Not acceptable. Request text/html or text/markdown.\n",
      {
        status: 406,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Vary: VARY_HEADER,
        },
      },
    );
  }

  const markdownAlternate = getMarkdownAlternate(pathname);
  return next({
    headers: {
      ...(markdownAlternate
        ? {
            Link: `<${markdownAlternate}>; rel="alternate"; type="text/markdown"`,
          }
        : {}),
      Vary: VARY_HEADER,
    },
  });
}
