import { describe, expect, it, vi } from "vitest";
import { fetchDownload } from "../api/download";
import { LATEST_RELEASE_URL } from "./site";

const DMG = "https://github.com/elie222/rakazo/releases/download/v2.0.0/Rakazo-2.0.0-universal.dmg";
const release = vi.fn(async () =>
  Response.json({ assets: [{ name: "Rakazo-2.0.0-universal.dmg", browser_download_url: DMG }] }),
) as unknown as typeof fetch;

function download(query: string, fetchImpl = release) {
  return fetchDownload(new Request(`https://rakazo.com/api/download${query}`), fetchImpl);
}

describe("download redirect", () => {
  it("sends each platform to the newest installer", async () => {
    const response = await download("?platform=mac");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(DMG);
    expect(response.headers.get("cache-control")).toContain("s-maxage=");
  });

  it("falls back to the latest release page", async () => {
    const failing = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;

    for (const response of [
      await download("?platform=linux"),
      await download("?platform=constructor"),
      await download(""),
      await download("?platform=mac", failing),
    ]) {
      expect(response.headers.get("location")).toBe(LATEST_RELEASE_URL);
    }
  });
});
