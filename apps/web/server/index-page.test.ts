import { describe, expect, it } from "vitest";
import { publicOrigin, withAbsoluteSocialImage } from "./index-page";

describe("index page", () => {
  it("names the preview image in full only for a host crawlers can reach", () => {
    const html = '<meta property="og:image" content="/og-image.png" />';
    expect(publicOrigin("localhost:8080")).toBeUndefined();
    expect(withAbsoluteSocialImage(html, publicOrigin("app.example.test")!)).toBe(
      '<meta property="og:image" content="https://app.example.test/og-image.png" />',
    );
  });
});
