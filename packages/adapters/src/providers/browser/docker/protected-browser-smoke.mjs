import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

if (process.argv[2] === "fixture") {
  const server = createServer(
    {
      key: readFileSync(process.argv[3]),
      cert: readFileSync(process.argv[4]),
    },
    async (request, response) => {
      if (request.method === "POST") {
        request.setEncoding("utf8");
        let body = "";
        for await (const chunk of request) body += chunk;
        if (new URLSearchParams(body).get("password") !== "synthetic-password") {
          response
            .writeHead(403, { "set-cookie": "visitor=synthetic-anonymous; Secure; Path=/" })
            .end();
          return;
        }
        response
          .writeHead(200, {
            "set-cookie": "session=synthetic-cookie; Secure; HttpOnly; Path=/",
          })
          .end();
        return;
      }

      if (request.url === "/private-redirect") {
        response.writeHead(302, { location: "https://127.0.0.1/" }).end();
        return;
      }

      response.setHeader("content-type", "text/html");
      response.end(
        request.headers.cookie?.includes("session=synthetic-cookie")
          ? "<h1>Synthetic account</h1><p>synthetic-cookie synthetic+form+value</p>"
          : `<form method="post"><label>Password <input name="password" type="password"></label><button>Sign in</button></form>
             <script>
               document.querySelector("form").addEventListener("submit", async (event) => {
                 event.preventDefault();
                 const response = await fetch("/", { method: "POST", body: new URLSearchParams(new FormData(event.target)) });
                 if (!response.ok) return;
                 localStorage.setItem("session", "synthetic form value");
                 document.body.innerHTML = "<h1>Synthetic account</h1>";
               });
             </script>`,
      );
    },
  );
  server.listen(443, "93.184.216.34");
  await once(server, "listening");
  process.stdout.write("Fixture ready\n");
} else {
  const { ProtectedBrowserError } = await import("../../../browser/protected-browser.ts");
  const { createProtectedBrowserLauncher } = await import("./docker-protected-browser.ts");
  const run = createProtectedBrowserLauncher({
    image: "rakazo/protected-browser:smoke",
    seccompProfile: process.argv[2],
  });
  const url = "https://protected-browser-fixture.example.com";
  await assert.rejects(run({ mode: "sign-in", url, steps: [] }), {
    name: "Error",
    code: "sign-in-rejected",
    message: "The protected browser operation failed.",
  });
  await assert.rejects(
    run({
      mode: "sign-in",
      url,
      steps: [
        { kind: "fill", role: "textbox", name: "Password", text: "synthetic-wrong-password" },
        { kind: "click", role: "button", name: "Sign in" },
        { kind: "wait", role: "heading", name: "Synthetic account" },
      ],
    }),
    { code: "sign-in-rejected" },
  );
  const { storageState } = await run({
    mode: "sign-in",
    url,
    steps: [
      { kind: "fill", role: "textbox", name: "Password", text: "synthetic-password" },
      { kind: "click", role: "button", name: "Sign in" },
      { kind: "wait", role: "heading", name: "Synthetic account" },
    ],
  });
  assert.ok(storageState.cookies.some(({ value }) => value === "synthetic-cookie"));
  assert.ok(
    storageState.origins.some(
      ({ origin, localStorage }) =>
        origin === url &&
        localStorage.some(
          ({ name, value }) => name === "session" && value === "synthetic form value",
        ),
    ),
  );
  const { page } = await run({ mode: "browse", url, storageState, steps: [] });
  assert.match(page, /Synthetic account/);
  assert.doesNotMatch(page, /synthetic-cookie|synthetic\+form\+value/);
  for (const blocked of [
    "https://169.254.169.254/",
    "https://private-protected-browser-fixture.example.com/",
    `${url}/private-redirect`,
  ]) {
    await assert.rejects(
      run({ mode: "browse", url: blocked, storageState: { cookies: [], origins: [] }, steps: [] }),
      (error) =>
        error instanceof ProtectedBrowserError &&
        error.code === "container-exit" &&
        error.message === "The protected browser operation failed.",
    );
  }
}
