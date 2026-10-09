import { describe, expect, it, vi } from "vitest";

vi.mock("expo-file-system", () => {
  class Node {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get exists() {
      return true;
    }
    create() {}
  }
  class File extends Node {
    write() {}
    text() {
      return Promise.resolve("");
    }
    copySync() {}
  }
  class Directory extends Node {}
  return { File, Directory, Paths: { cache: { uri: "file:///cache" } } };
});
vi.mock("expo-sharing", () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
vi.mock("./api", () => ({ rpc: vi.fn() }));

import { rpc } from "./api";
import { ARTIFACT_DOWNLOAD_TIMEOUT_MS, readMobileArtifactText } from "./artifact-open";

describe("artifact downloads", () => {
  it("give the RPC a budget sized for multi-megabyte payloads instead of the default", async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ contentBase64: "aGk=" });
    await readMobileArtifactText({ botId: "bot-1" }, "art-1", "text/plain");
    expect(rpc).toHaveBeenCalledWith(
      "artifacts/get",
      { botId: "bot-1", artifactId: "art-1" },
      { timeoutMs: ARTIFACT_DOWNLOAD_TIMEOUT_MS },
    );
    // 10 MiB of base64 over a relayed cellular link takes well over the 8 s RPC default.
    expect(ARTIFACT_DOWNLOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
