import { cp, mkdir, writeFile } from "node:fs/promises";

const runtime = new URL(process.env.API_PROXY_TARGET ?? "");
if (
  runtime.protocol !== "https:" ||
  runtime.username ||
  runtime.password ||
  runtime.pathname !== "/"
) {
  throw new Error("API_PROXY_TARGET must be the HTTPS origin of the cloud runtime");
}
await mkdir(".vercel/output", { recursive: true });
await cp("apps/web/dist", ".vercel/output/static", { recursive: true });
await writeFile(
  ".vercel/output/config.json",
  JSON.stringify({
    version: 3,
    routes: [
      ...["api", "rpc"].map((prefix) => ({
        src: `/${prefix}/(.*)`,
        dest: `${runtime.origin}/${prefix}/$1`,
        headers: { "cache-control": "private, no-store", "x-vercel-enable-rewrite-caching": "0" },
      })),
      { handle: "filesystem" },
      { src: "/(.*)", dest: "/index.html" },
    ],
  }),
);
