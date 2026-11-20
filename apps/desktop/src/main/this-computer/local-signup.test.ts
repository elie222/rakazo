import { LOCAL_SIGNUP_COOKIE, localSignupKey } from "@rakazo/core/node/local-signup";
import { expect, it, vi } from "vitest";
import { syncLocalSignup } from "./local-signup.js";

const cookies = () => ({ set: vi.fn(), remove: vi.fn() });

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
  await syncLocalSignup({ cookies: jar } as never, "http://127.0.0.1:5173", null);
  expect(jar.set).not.toHaveBeenCalled();
  expect(jar.remove).toHaveBeenCalledWith("http://127.0.0.1:5173", LOCAL_SIGNUP_COOKIE);
});
