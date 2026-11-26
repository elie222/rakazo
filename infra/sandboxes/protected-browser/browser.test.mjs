import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pageSnapshot, runBrowser } from "./browser.mjs";

test("redacts individual session values in nested JSON storage", () => {
  const state = {
    cookies: [],
    origins: [
      {
        localStorage: [
          {
            value: JSON.stringify({
              session: [JSON.stringify({ token: "synthetic nested/token" })],
            }),
          },
        ],
      },
    ],
  };
  assert.equal(
    pageSnapshot("Orders synthetic nested/token synthetic%20nested%2Ftoken", state),
    "Orders [redacted] [redacted]",
  );
});

test("a fresh protected browser resumes the synthetic signed-in session", async () => {
  const { chromium } = await import("playwright-core");
  const dir = await mkdtemp(join(tmpdir(), "protected-browser-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const fixtureCookie = "synthetic-session-cookie";
  let server;
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      async (req, res) => {
        if (req.method === "POST") {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const form = new URLSearchParams(Buffer.concat(chunks).toString());
          if (form.get("password") !== "synthetic-password") {
            res.writeHead(401).end();
            return;
          }
          res
            .writeHead(303, {
              "Set-Cookie": `session=${fixtureCookie}; Secure; HttpOnly; Path=/`,
              Location: "/",
            })
            .end();
          return;
        }
        res.setHeader("Content-Type", "text/html");
        if (req.headers.cookie === `session=${fixtureCookie}`) {
          const heading = req.url === "/orders" ? "Signed-in orders" : "Signed-in fixture";
          res.end(`<h1>${heading}</h1><a href="/orders">Orders</a><p>${fixtureCookie}</p>`);
          return;
        }
        res.end(
          '<form method="post"><label>Password <input type="password" name="password" aria-label="Password"></label><button>Sign in</button></form>',
        );
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `https://127.0.0.1:${server.address().port}`;
    const launch = { args: ["--ignore-certificate-errors"] };
    await assert.rejects(
      runBrowser(chromium, { mode: "sign-in", url, steps: [] }, launch),
      /Sign-in produced no reusable browser state/,
    );
    const signedIn = await runBrowser(
      chromium,
      {
        mode: "sign-in",
        url,
        steps: [
          { kind: "fill", role: "textbox", name: "Password", text: "synthetic-password" },
          { kind: "click", role: "button", name: "Sign in" },
        ],
      },
      launch,
    );
    assert.deepEqual(Object.keys(signedIn), ["storageState"]);
    const result = await runBrowser(
      chromium,
      {
        mode: "browse",
        url,
        storageState: signedIn.storageState,
        steps: [{ kind: "click", role: "link", name: "Orders" }],
      },
      launch,
    );
    assert.match(result.page, /Signed-in orders/);
    assert.doesNotMatch(result.page, /synthetic-session-cookie|synthetic-password/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
