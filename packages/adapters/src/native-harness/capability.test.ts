import type { ComputerExecutionCapability, ComputerRef } from "@rakazo/adapter-kit";
import { createAdapterContext, supportsComputerExecution } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { ConfiguredSandbox } from "./../computers/sandbox/configured-sandbox.js";
import { HostAwareSandbox } from "./../computers/sandbox/host-aware-sandbox.js";
import { FakeSandboxProvider } from "../providers/computer/fake/fake-sandbox.js";

it("forwards optional execution through configured and host routing with the original scope", async () => {
  const execution = vi.fn<ComputerExecutionCapability["execution"]>().mockResolvedValue(undefined);
  const isolated = Object.assign(new FakeSandboxProvider(), { execution });
  const host = new FakeSandboxProvider();
  const routed = new HostAwareSandbox(isolated, host, async () => false);
  const sandbox = new ConfiguredSandbox(routed, async () => ({
    provider: "default",
    settings: null,
  }));
  const computer: ComputerRef = {
    id: "computer-a",
    botId: "home-a",
    kind: "docker",
    providerRef: "container-a",
  };
  const context = createAdapterContext({ userId: "user-a", spaceId: "space-a" }, "", "test");
  expect(supportsComputerExecution(sandbox)).toBe(true);
  await sandbox.execution(computer, context, "service-a");
  expect(execution).toHaveBeenCalledExactlyOnceWith(computer, context, "service-a");

  execution.mockClear();
  expect(supportsComputerExecution(host)).toBe(false);
  expect(await sandbox.execution({ ...computer, kind: "desktop" }, context)).toBeUndefined();
  expect(execution).not.toHaveBeenCalled();
});
