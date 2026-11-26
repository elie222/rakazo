import { LOCAL_SIGNUP_COOKIE, localSignupKey } from "@rakazo/core/node/local-signup";
import { expect, it, vi } from "vitest";
import { syncLocalSignup } from "./local-signup.js";

// Like Electron: remove(url, name) only deletes cookies whose path matches the url's path.
const cookies = () => {
  const stored = new Map<string, string>();
  return {
    stored,
    set: vi.fn(async (details: { url: string; name: string; path: string }) => {
      stored.set(`${details.path}|${details.name}`, details.url);
    }),
    remove: vi.fn(async (url: string, name: string) => {
      const path = new URL(url).pathname;
      stored.delete(`${path}|${name}`);
    }),
  };
};

it("sets a cookie the page cannot read, for the local server's auth routes only", async () => {
  const jar = cookies();
  const token = "ab".repeat(32);
  await syncLocalSignup({ cookies: jar } as never, "http://127.0.0.1:5173/chat", token);
  expect(jar.set).toHaveBeenCalledWith({
    url: "http://127.0.0.1:5173",
    name: LOCAL_SIGNUP_COOKIE,
    value: localSignupKey(token),
    path: "/api/auth",
    httpOnly: true,
    sameSite: "lax",
  });
  expect(localSignupKey(token)).not.toContain(token);
});

it("removes the cookie when the session opens another server", async () => {
  const jar = cookies();
  const token = "ab".repeat(32);
  await syncLocalSignup({ cookies: jar } as never, "http://127.0.0.1:5173", token);
  expect(jar.stored.size).toBe(1);
  await syncLocalSignup({ cookies: jar } as never, "http://127.0.0.1:5173", null);
  expect(jar.stored.size).toBe(0);
});
