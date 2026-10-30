import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import * as hostComputerServer from "@rakazo/adapters/host-computer-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareHostComputer } from "./host-computer.js";

describe("desktop local computer consent", () => {
  let root: string;
  let computer: Awaited<ReturnType<typeof prepareHostComputer>>;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rakazo-native-consent-"));
    computer = await prepareHostComputer(root);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await computer.close();
    await rm(root, { recursive: true, force: true });
  });

  it("rotates the credential and requires consent again if another listener claims the saved port", async () => {
    await computer.grant();
    const previous = computer.connection;
    const port = Number(new URL(previous.url).port);
    await computer.close();
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(port, "0.0.0.0", resolve));
    try {
      computer = await prepareHostComputer(root);
      expect(computer.connection.token).not.toBe(previous.token);
      computer.activate(true);
      expect(computer.isEnabled()).toBe(false);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("replaces a reserved saved port and revokes the old credential and consent", async () => {
    await computer.grant();
    const previous = computer.connection;
    const port = Number(new URL(previous.url).port);
    await computer.close();
    const start = vi.spyOn(hostComputerServer, "startHostComputerServer");
    start.mockRejectedValueOnce(Object.assign(new Error("Reserved port"), { code: "EACCES" }));
    computer = await prepareHostComputer(root);
    expect(start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ port, token: previous.token }),
    );
    expect(start).toHaveBeenNthCalledWith(2, {
      root: path.join(root, "computers"),
      token: computer.connection.token,
    });
    expect(computer.connection.token).not.toBe(previous.token);
    const saved = JSON.parse(await readFile(path.join(root, "host-computer.json"), "utf8"));
    expect(saved).toEqual({
      token: computer.connection.token,
      port: Number(new URL(computer.connection.url).port),
    });
    computer.activate(true);
    expect(computer.isEnabled()).toBe(false);
  });

  it.each([
    Object.assign(new Error("Operation not permitted"), { code: "EPERM" }),
    new Error("Unexpected listen failure"),
  ])("preserves the saved connection and consent when startup fails with %s", async (error) => {
    await computer.grant();
    await computer.close();
    const configFile = path.join(root, "host-computer.json");
    const consentFile = path.join(root, "host-computer-consent");
    const config = await readFile(configFile, "utf8");
    const consent = await readFile(consentFile, "utf8");
    const start = vi.spyOn(hostComputerServer, "startHostComputerServer").mockRejectedValue(error);
    await expect(prepareHostComputer(root)).rejects.toBe(error);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await readFile(configFile, "utf8")).toBe(config);
    expect(await readFile(consentFile, "utf8")).toBe(consent);
  });

  it("keeps a later revocation when an earlier grant is still being persisted", async () => {
    computer.activate(true);
    await Promise.all([computer.grant(), computer.revoke()]);
    expect(computer.isEnabled()).toBe(false);
    await computer.close();
    computer = await prepareHostComputer(root);
    computer.activate(true);
    expect(computer.isEnabled()).toBe(false);
  });

  it("remembers consent but only activates for the app-managed instance", async () => {
    computer.activate(true);
    expect(computer.isEnabled()).toBe(false);
    await computer.grant();
    expect(computer.isEnabled()).toBe(true);
    computer.activate(false);
    expect(computer.isEnabled()).toBe(false);
    const connection = computer.connection;
    await computer.close();
    computer = await prepareHostComputer(root);
    expect(computer.connection).toEqual(connection);
    expect(computer.isEnabled()).toBe(false);
    computer.activate(true);
    expect(computer.isEnabled()).toBe(true);
    await computer.revoke();
    expect(computer.isEnabled()).toBe(false);
    expect(await readFile(path.join(root, "host-computer-consent"), "utf8")).toBe("");
    computer.activate(true);
    expect(computer.isEnabled()).toBe(false);
    await computer.close();
    computer = await prepareHostComputer(root);
    computer.activate(true);
    expect(computer.isEnabled()).toBe(false);
  });
});
