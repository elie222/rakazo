import { MOBILE_MCP_OAUTH_CALLBACK_URL } from "@rakazo/contracts";
import { openAuthSessionAsync, WebBrowserResultType } from "expo-web-browser";
import { beforeEach, expect, it, vi } from "vitest";
import { rpc } from "./api";
import { signInToMcpServer } from "./mcp-oauth";

vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: vi.fn(),
  WebBrowserResultType: { CANCEL: "cancel" },
}));
vi.mock("./api", () => ({ rpc: vi.fn() }));

const SESSION = "mobile-session-1";

beforeEach(() => {
  vi.mocked(rpc).mockReset();
  vi.mocked(openAuthSessionAsync).mockReset();
  vi.mocked(rpc).mockImplementation((async (path: string) =>
    path === "mcp/oauth/begin"
      ? {
          status: "authorization_required",
          sessionId: SESSION,
          authorizationUrl: "https://auth.example.test/authorize",
        }
      : { ok: true }) as never);
});

function returnWith(params: Record<string, string>) {
  vi.mocked(openAuthSessionAsync).mockResolvedValue({
    type: "success",
    url: `${MOBILE_MCP_OAUTH_CALLBACK_URL}?${new URLSearchParams(params)}`,
  });
}

it("finishes the sign-in in the app once the browser hands the code back", async () => {
  returnWith({ code: "code-1", state: SESSION });

  await expect(signInToMcpServer("server-1")).resolves.toBe("connected");

  expect(rpc).toHaveBeenCalledWith("mcp/oauth/begin", { serverId: "server-1", client: "mobile" });
  expect(openAuthSessionAsync).toHaveBeenCalledWith(
    "https://auth.example.test/authorize",
    MOBILE_MCP_OAUTH_CALLBACK_URL,
  );
  expect(rpc).toHaveBeenCalledWith("mcp/oauth/complete", {
    sessionId: SESSION,
    code: "code-1",
    state: SESSION,
  });
});

it("refuses a code returned for another sign-in", async () => {
  returnWith({ code: "code-1", state: "mobile-other" });

  await expect(signInToMcpServer("server-1")).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalledWith("mcp/oauth/complete", expect.anything());
});

it("treats closing the browser or declining access as cancelled", async () => {
  vi.mocked(openAuthSessionAsync).mockResolvedValueOnce({ type: WebBrowserResultType.CANCEL });
  await expect(signInToMcpServer("server-1")).resolves.toBe("cancelled");

  returnWith({ error: "access_denied", state: SESSION });
  await expect(signInToMcpServer("server-1")).resolves.toBe("cancelled");

  expect(rpc).not.toHaveBeenCalledWith("mcp/oauth/complete", expect.anything());
});

it("shows the provider's reason when the sign-in fails", async () => {
  returnWith({ error: "server_error", error_description: "Try later", state: SESSION });

  await expect(signInToMcpServer("server-1")).rejects.toThrow("Try later");
});

it("skips the browser when the server is already signed in", async () => {
  vi.mocked(rpc).mockResolvedValueOnce({ status: "already_connected" } as never);

  await expect(signInToMcpServer("server-1")).resolves.toBe("already_connected");
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
});
