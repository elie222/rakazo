import { MOBILE_MCP_OAUTH_CALLBACK_URL } from "@rakazo/contracts";
import { openAuthSessionAsync } from "expo-web-browser";
import { beforeEach, expect, it, vi } from "vitest";
import type { SaveSend } from "../query/query";
import { signInToMcpServer } from "./mcp-oauth";

vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

const SESSION = "mobile-session-1";
const send = vi.fn();

beforeEach(() => {
  vi.mocked(openAuthSessionAsync).mockReset();
  send.mockReset().mockImplementation(async (path: string) =>
    path === "mcp/oauth/begin"
      ? {
          status: "authorization_required",
          sessionId: SESSION,
          authorizationUrl: "https://auth.example.test/authorize",
        }
      : { ok: true },
  );
});

function returnWith(params: Record<string, string>) {
  vi.mocked(openAuthSessionAsync).mockResolvedValue({
    type: "success",
    url: `${MOBILE_MCP_OAUTH_CALLBACK_URL}?${new URLSearchParams(params)}`,
  });
}

const signIn = () => signInToMcpServer(send as unknown as SaveSend, "server-1");

it("finishes the sign-in in the app once the browser hands the code back", async () => {
  returnWith({ code: "code-1", state: SESSION });

  await expect(signIn()).resolves.toBe("connected");

  expect(send).toHaveBeenCalledWith("mcp/oauth/begin", { serverId: "server-1", client: "mobile" });
  expect(openAuthSessionAsync).toHaveBeenCalledWith(
    "https://auth.example.test/authorize",
    MOBILE_MCP_OAUTH_CALLBACK_URL,
  );
  expect(send).toHaveBeenCalledWith("mcp/oauth/complete", {
    sessionId: SESSION,
    state: SESSION,
    code: "code-1",
  });
});

it("reads a refusal at the provider as cancelled and reports its other errors", async () => {
  returnWith({ error: "access_denied", state: SESSION });
  await expect(signIn()).resolves.toBe("cancelled");

  returnWith({ error: "server_error", error_description: "Provider is down", state: SESSION });
  await expect(signIn()).rejects.toThrow("Provider is down");
  expect(send).not.toHaveBeenCalledWith("mcp/oauth/complete", expect.anything());
});

it("refuses a code returned for another sign-in", async () => {
  returnWith({ code: "code-1", state: "mobile-session-0" });

  await expect(signIn()).rejects.toThrow();
  expect(send).not.toHaveBeenCalledWith("mcp/oauth/complete", expect.anything());
});

it("treats closing the browser as cancelled", async () => {
  vi.mocked(openAuthSessionAsync).mockResolvedValueOnce({ type: "cancel" } as never);

  await expect(signIn()).resolves.toBe("cancelled");
  expect(send).not.toHaveBeenCalledWith("mcp/oauth/complete", expect.anything());
});

it("skips the browser when the server is already signed in", async () => {
  send.mockResolvedValueOnce({ status: "already_connected" });

  await expect(signIn()).resolves.toBe("already_connected");
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
});
