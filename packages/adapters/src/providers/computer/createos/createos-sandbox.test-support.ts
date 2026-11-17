import { parse } from "shell-quote";
import { simpleCommand } from "../../../linux-desktop.test-support.js";
import { CreateOSSandboxProvider } from "./createos-sandbox.js";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The real CreateOS adapter over an in-memory API: sandboxes that run until deleted, and a shell
 * that understands the adapter's command wrapper with `env`, `echo` and `printenv`.
 */
export function emulatedCreateOS() {
  const sandboxes = new Set<string>();
  let sequence = 0;
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const [, , , id, action] = url.pathname.split("/");
    if (method === "POST" && !id) {
      const created = `sbx-${++sequence}`;
      sandboxes.add(created);
      return reply(200, { status: "success", data: { id: created, status: "running" } });
    }
    if (!id || !sandboxes.has(id)) {
      return reply(404, {
        status: "fail",
        data: { code: "sandbox_not_found", error: "sandbox not found" },
      });
    }
    if (method === "DELETE" && !action) sandboxes.delete(id);
    if (method === "POST" && action === "exec") {
      const body = JSON.parse(String(init?.body)) as { args: string[]; stdin?: string };
      const env: Record<string, string> = {};
      for (const line of (body.stdin ?? "").split("\n")) {
        const [keyword, assignment] = parse(line);
        if (keyword !== "export" || typeof assignment !== "string") continue;
        const [name, ...value] = assignment.split("=");
        env[name!] = value.join("=");
      }
      const command = body.args.at(-1)!.split(" && ").at(-1)!;
      const parsed = parse(command);
      const argv = parsed.filter((token): token is string => typeof token === "string");
      const { exitCode = 0, stdout = "" } =
        argv.length === parsed.length ? simpleCommand(argv, env) : {};
      return reply(200, { status: "success", data: { result: { stdout, exit_code: exitCode } } });
    }
    return reply(200, { status: "success", data: { id, status: "running" } });
  }) as typeof fetch;
  return {
    sandboxes,
    provider: new CreateOSSandboxProvider({ apiKey: "test-createos-key", fetch: fetchImpl }),
  };
}
