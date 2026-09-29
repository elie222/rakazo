import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const composeDir = path.resolve(import.meta.dirname, "../../compose");
const caddyfiles = ["Caddyfile.prod", "Caddyfile.cloudflare.example"];

describe.each(caddyfiles)("%s HSTS", (filename) => {
  const config = readFileSync(path.join(composeDir, filename), "utf8");
  const httpsSite = config.slice(config.lastIndexOf("{$RAKAZO_HOST:app.example.com} {"));

  it("sends HSTS from the HTTPS site without preloading", () => {
    expect(httpsSite).toContain('header @hsts Strict-Transport-Security "max-age=31536000"');
    expect(config).not.toContain("preload");
  });

  it("never pins HTTPS onto localhost", () => {
    expect(httpsSite).toContain("@hsts not host localhost 127.0.0.1");
  });

  it("stops other sites framing the app and sniffing responses", () => {
    expect(httpsSite).toContain("X-Content-Type-Options nosniff");
    expect(httpsSite).toContain("X-Frame-Options SAMEORIGIN");
    expect(httpsSite).not.toContain("frame-ancestors 'none'");
  });

  it("replaces the client-supplied forwarding header on API requests", () => {
    expect(httpsSite).toContain(
      filename.startsWith("Caddyfile.cloudflare")
        ? "header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}"
        : "header_up X-Forwarded-For {remote_host}",
    );
  });
});
