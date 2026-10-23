import { describe, expect, it, vi } from "vitest";
import { saveLocalComputerHost } from "./local-settings.js";

const target = { origin: "http://127.0.0.1:5173", token: "ab".repeat(32) };
describe("native computer host transport", () => {
  it("uses only the local capability and refuses a remote origin", async () => {
    const request = vi.fn(async () => new Response('{"ok":true}'));
    await saveLocalComputerHost(target, "this-mac", request);
    expect(request).toHaveBeenCalledWith(
      `${target.origin}/api/desktop-settings/computer-host`,
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        body: '{"computerHost":"this-mac"}',
      }),
    );
    request.mockClear();
    await expect(
      saveLocalComputerHost({ ...target, origin: "https://example.test" }, "this-mac", request),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("reports an unsuccessful save so native main can revoke a newly granted permission", async () => {
    await expect(
      saveLocalComputerHost(target, "this-mac", async () => new Response("", { status: 403 })),
    ).rejects.toThrow("Could not save local computer choice");
  });
});
