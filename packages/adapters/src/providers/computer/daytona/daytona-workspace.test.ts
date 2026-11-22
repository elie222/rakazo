import type { FileInfo } from "@daytona/sdk";
import { DaytonaNotFoundError } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import { DaytonaSandboxProvider } from "./daytona-sandbox.js";
import { daytonaFixture } from "./daytona-sandbox.test-support.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
} as const;

async function setup() {
  const fixture = daytonaFixture();
  const provider = new DaytonaSandboxProvider({}, fixture.client);
  const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
  await provider.writeFile(computer, { path: "a.txt", content: Buffer.from("a") }, context);
  await provider.writeFile(computer, { path: "tmp/b.txt", content: Buffer.from("b") }, context);
  // Spying returns the existing mock. Its working implementation is read here, before any test
  // replaces it, so each test can fail only the read it names.
  const listSpy = vi.spyOn(fixture.sandbox.fs, "listFiles");
  const downloadSpy = vi.spyOn(fixture.sandbox.fs, "downloadFile");
  const working = {
    listFiles: listSpy.getMockImplementation() as (directory: string) => Promise<FileInfo[]>,
    downloadFile: downloadSpy.getMockImplementation() as (target: string) => Promise<Buffer>,
  };
  const exportPaths = async () => {
    const paths = [];
    for await (const file of provider.exportWorkspace(computer, context)) paths.push(file.path);
    return paths.sort();
  };
  return { fixture, working, exportPaths };
}

describe("Daytona workspace export", () => {
  it("leaves out a file deleted after it was listed and yields the rest", async () => {
    const { fixture, working, exportPaths } = await setup();
    vi.spyOn(fixture.sandbox.fs, "downloadFile").mockImplementation(async (target: string) => {
      if (target.endsWith("/a.txt")) throw new DaytonaNotFoundError("File not found", 404);
      return working.downloadFile(target);
    });

    await expect(exportPaths()).resolves.toEqual(["tmp/b.txt"]);
  });

  it("leaves out a folder deleted after its parent listed it and yields the rest", async () => {
    const { fixture, working, exportPaths } = await setup();
    vi.spyOn(fixture.sandbox.fs, "listFiles").mockImplementation(async (directory: string) => {
      if (directory.endsWith("/tmp")) throw new DaytonaNotFoundError("Folder not found", 404);
      return working.listFiles(directory);
    });

    await expect(exportPaths()).resolves.toEqual(["a.txt"]);
  });

  it("fails the export when the sandbox itself is gone, not just one entry", async () => {
    const { fixture, working, exportPaths } = await setup();
    const notFound = new DaytonaNotFoundError("Sandbox not found", 404);
    let listings = 0;
    // The first listing succeeds; after that the whole sandbox answers not found.
    vi.spyOn(fixture.sandbox.fs, "listFiles").mockImplementation(async (directory: string) => {
      listings += 1;
      if (listings > 1) throw notFound;
      return working.listFiles(directory);
    });
    vi.spyOn(fixture.sandbox.fs, "downloadFile").mockImplementation(async (target: string) => {
      if (target.endsWith("/a.txt")) throw notFound;
      return working.downloadFile(target);
    });

    await expect(exportPaths()).rejects.toBe(notFound);
  });

  it("fails the export on any other download or listing error", async () => {
    const { fixture, working, exportPaths } = await setup();
    const outage = Object.assign(new Error("Daytona is unavailable"), { statusCode: 503 });
    vi.spyOn(fixture.sandbox.fs, "downloadFile").mockImplementation(async (target: string) => {
      if (target.endsWith("/a.txt")) throw outage;
      return working.downloadFile(target);
    });
    await expect(exportPaths()).rejects.toBe(outage);

    const denied = Object.assign(new Error("Forbidden"), { statusCode: 403 });
    vi.spyOn(fixture.sandbox.fs, "downloadFile").mockImplementation(working.downloadFile);
    vi.spyOn(fixture.sandbox.fs, "listFiles").mockImplementation(async (directory: string) => {
      if (directory.endsWith("/tmp")) throw denied;
      return working.listFiles(directory);
    });
    await expect(exportPaths()).rejects.toBe(denied);
  });
});
