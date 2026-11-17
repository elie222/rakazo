import { describe, expect, it } from "vitest";
import { updateConfigBindsPublisher } from "./update-publisher.js";

const feed = (publisherLines: string) =>
  `owner: example\nrepo: app\nprovider: github\n${publisherLines}updaterCacheDirName: app-updater\n`;

describe("updateConfigBindsPublisher", () => {
  it("accepts the configured publisher", () => {
    expect(updateConfigBindsPublisher(feed("publisherName:\n  - Example Co\n"), "Example Co")).toBe(
      true,
    );
  });

  it("decodes a publisher that YAML has to quote", () => {
    expect(
      updateConfigBindsPublisher(
        feed("publisherName:\n  - 'Example: Software'\n"),
        "Example: Software",
      ),
    ).toBe(true);
  });

  it("rejects a missing, different, or additional publisher", () => {
    expect(updateConfigBindsPublisher(feed(""), "Example Co")).toBe(false);
    expect(updateConfigBindsPublisher(feed("publisherName:\n  - Other\n"), "Example Co")).toBe(
      false,
    );
    expect(
      updateConfigBindsPublisher(feed("publisherName:\n  - Example Co\n  - Other\n"), "Example Co"),
    ).toBe(false);
    expect(updateConfigBindsPublisher(feed("publisherName:\n  - ''\n"), "")).toBe(false);
  });
});
