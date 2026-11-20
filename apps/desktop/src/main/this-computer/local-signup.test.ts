import { LOCAL_SIGNUP_COOKIE, localSignupKey } from "@rakazo/core/node/local-signup";
import { expect, it, vi } from "vitest";
import { allowLocalSignup } from "./local-signup.js";

it("sets a cookie the page cannot read, for the local server's auth routes only", async () => {
  const set = vi.fn();
  const token = "ab".repeat(32);
  await allowLocalSignup({ cookies: { set } } as never, "http://127.0.0.1:5173/chat", token);
  expect(set).toHaveBeenCalledWith({
    url: "http://127.0.0.1:5173",
    name: LOCAL_SIGNUP_COOKIE,
    value: localSignupKey(token),
    path: "/api/auth",
    httpOnly: true,
    sameSite: "lax",
  });
  expect(localSignupKey(token)).not.toContain(token);
});

it("sets nothing before the stack has a token", async () => {
  const set = vi.fn();
  await allowLocalSignup({ cookies: { set } } as never, "http://127.0.0.1:5173", null);
  expect(set).not.toHaveBeenCalled();
});
