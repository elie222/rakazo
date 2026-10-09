import { expect, vi } from "vitest";
import type { InfisicalSecretStoreOptions } from "./infisical-secret-store.js";

/** Strict offline REST fake shared by provider and credential-boundary tests. */
export function infisicalFake() {
  const values = new Map<string, string>();
  const statuses: number[] = [];
  const loginStatuses: number[] = [];
  let logins = 0;
  let expiresIn = 3600;
  let offline = false;
  let gate: (() => Promise<void>) | undefined;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://secrets.example.test");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    init?.signal?.throwIfAborted();
    if (offline) throw new Error("private response value");
    if (gate) await gate();
    init?.signal?.throwIfAborted();
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    if (url.pathname === "/api/v1/auth/universal-auth/login") {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        clientId: "fake-client",
        clientSecret: "fake-client-secret",
      });
      logins++;
      const status = loginStatuses.shift() ?? 200;
      return Response.json({ accessToken: `token-${logins}`, expiresIn }, { status });
    }
    expect(headers.get("authorization")).toMatch(/^Bearer token-[1-9][0-9]*$/);
    expect(Number(headers.get("authorization")?.split("-").at(-1))).toBeLessThanOrEqual(logins);
    expect(url.pathname).toMatch(/^\/api\/v3\/secrets\/raw\/rakazo_[a-f0-9]{24}_[a-f0-9-]{36}$/);
    const key = url.pathname.split("/").at(-1)!;
    const scope = {
      workspaceId: "fake-project",
      environment: "test",
      secretPath: "/rakazo",
      type: "shared",
    };
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === "GET")
      expect(Object.fromEntries(url.searchParams)).toEqual({
        ...scope,
        expandSecretReferences: "false",
        includeImports: "false",
      });
    else
      expect(body).toEqual(
        init?.method === "POST" ? { ...scope, secretValue: expect.any(String) } : scope,
      );
    const status = statuses.shift();
    if (status && status !== 200)
      return Response.json({ message: "private response value" }, { status });
    if (init?.method === "POST") {
      values.set(key, body.secretValue);
      return Response.json({ secret: { secretValue: body.secretValue } });
    }
    if (!values.has(key)) return Response.json({}, { status: 404 });
    if (init?.method === "DELETE") {
      values.delete(key);
      return new Response(null, { status: 204 });
    }
    return Response.json({ secret: { secretValue: values.get(key) } });
  });
  const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
    signal.throwIfAborted();
  });
  const options: InfisicalSecretStoreOptions = {
    baseUrl: "https://secrets.example.test",
    clientId: "fake-client",
    clientSecret: "fake-client-secret",
    projectId: "fake-project",
    environment: "test",
    folder: "/rakazo",
    fetch: fetcher,
    sleep,
  };
  return {
    values,
    statuses,
    loginStatuses,
    fetcher,
    sleep,
    options,
    get logins() {
      return logins;
    },
    set expiresIn(value: number) {
      expiresIn = value;
    },
    set offline(value: boolean) {
      offline = value;
    },
    set gate(value: (() => Promise<void>) | undefined) {
      gate = value;
    },
  };
}
