import { openAuthSessionAsync, WebBrowserResultType } from "expo-web-browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authHeaders, clearSpace, currentApiBase, fetchMobileJson } from "./api";
import { currentSessionGeneration, replaceSessionTokenIfCurrent } from "./session";
import { continueWithSso } from "./sso";

vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: vi.fn(),
  WebBrowserResultType: { CANCEL: "cancel", DISMISS: "dismiss" },
}));
vi.mock("./api", () => ({
  authHeaders: vi.fn(async () => ({ authorization: "Bearer old-session" })),
  clearSpace: vi.fn(async () => true),
  currentApiBase: vi.fn(() => "https://rakazo.example.test"),
  fetchMobileJson: vi.fn(),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: vi.fn(() => 1),
  replaceSessionTokenIfCurrent: vi.fn(async () => true),
  tokenFromAuthResponse: (response: Response) =>
    response.headers.get("set-cookie")?.match(/session_token=([^;]+)/)?.[1] ?? "",
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentApiBase).mockReturnValue("https://rakazo.example.test");
  vi.mocked(currentSessionGeneration).mockReturnValue(1);
  vi.mocked(clearSpace).mockResolvedValue(true);
  vi.mocked(fetchMobileJson).mockResolvedValue({
    response: Response.json({}),
    body: { user: { id: "user-1" } },
  });
  vi.mocked(fetchMobileJson).mockResolvedValueOnce({
    response: new Response(null, {
      headers: { "set-cookie": "better-auth.oauth_state=encrypted-state; Path=/; HttpOnly" },
    }),
    body: { url: "https://identity.example.test/authorize?state=test-state" },
  });
  vi.mocked(openAuthSessionAsync).mockResolvedValue({
    type: "success",
    url: `rakazo://sign-in?cookie=${encodeURIComponent("better-auth.session_token=new-session; Path=/; HttpOnly")}`,
  });
});
afterEach(() => vi.restoreAllMocks());
it("uses the Expo proxy, validates the session, and saves the existing session store", async () => {
  await expect(continueWithSso()).resolves.toBe(true);
  const [url, callback] = vi.mocked(openAuthSessionAsync).mock.calls[0]!;
  expect(callback).toBe("rakazo://sign-in");
  expect(new URL(url).pathname).toBe("/api/auth/expo-authorization-proxy");
  expect(new URL(url).searchParams.get("oauthState")).toBe("encrypted-state");
  expect(replaceSessionTokenIfCurrent).toHaveBeenCalledWith(1, "new-session");
  expect(clearSpace).toHaveBeenCalledOnce();
});
it.each([WebBrowserResultType.CANCEL, WebBrowserResultType.DISMISS])(
  "does not store a session on %s",
  async (type) => {
    vi.mocked(openAuthSessionAsync).mockResolvedValue({ type });
    await expect(continueWithSso()).resolves.toBe(false);
    expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  },
);
it.each([
  "https://attacker.example.test/?cookie=token",
  "rakazo://sign-in?error=account_not_linked",
  "rakazo://sign-in",
])("rejects invalid callbacks", async (url) => {
  vi.mocked(openAuthSessionAsync).mockResolvedValue({ type: "success", url });
  await expect(continueWithSso()).rejects.toThrow();
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});
it.each(["server", "session"])("drops results when the %s changes", async (changed) => {
  vi.mocked(openAuthSessionAsync).mockImplementation(async () => {
    if (changed === "server")
      vi.mocked(currentApiBase).mockReturnValue("https://other.example.test");
    else vi.mocked(currentSessionGeneration).mockReturnValue(2);
    return {
      type: "success",
      url: `rakazo://sign-in?cookie=${encodeURIComponent("better-auth.session_token=new-session; Path=/; HttpOnly")}`,
    };
  });
  await expect(continueWithSso()).rejects.toThrow();
  expect(fetchMobileJson).toHaveBeenCalledOnce();
  expect(clearSpace).not.toHaveBeenCalled();
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});
it("requires reauthentication to return the same account", async () => {
  vi.mocked(fetchMobileJson).mockReset();
  vi.mocked(fetchMobileJson)
    .mockResolvedValueOnce({ response: Response.json({}), body: { user: { id: "user-1" } } })
    .mockResolvedValueOnce({
      response: Response.json({}),
      body: { url: "https://identity.example.test/authorize?state=test-state" },
    })
    .mockResolvedValueOnce({ response: Response.json({}), body: { user: { id: "other-user" } } });
  vi.mocked(openAuthSessionAsync).mockResolvedValue({
    type: "success",
    url: `rakazo://account?cookie=${encodeURIComponent("better-auth.session_token=new-session; Path=/; HttpOnly")}`,
  });
  await expect(continueWithSso("reauthenticate")).rejects.toThrow();
  expect(authHeaders).toHaveBeenCalled();
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});
it("starts authenticated linking without replacing the session", async () => {
  vi.mocked(openAuthSessionAsync).mockResolvedValue({ type: "success", url: "rakazo://account" });
  await expect(continueWithSso("link")).resolves.toBe(true);
  expect(vi.mocked(fetchMobileJson).mock.calls[0]?.[0]).toContain("/link-social");
  expect(vi.mocked(fetchMobileJson).mock.calls[0]?.[1]?.headers).toMatchObject({
    authorization: "Bearer old-session",
  });
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});

it("does not send a different server's token during authenticated linking", async () => {
  vi.mocked(authHeaders).mockImplementationOnce(async () => {
    vi.mocked(currentApiBase).mockReturnValue("https://other.example.test");
    return { authorization: "Bearer other-server-session" };
  });
  await expect(continueWithSso("link")).rejects.toThrow();
  expect(fetchMobileJson).not.toHaveBeenCalled();
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
});
