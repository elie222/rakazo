// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { CloudComputers } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spaceQueries } from "../../lib/query/query";
import { CloudComputerSizes } from "./CloudComputerSizes";

const cloudComputers = vi.hoisted(() => ({ list: vi.fn(), setSize: vi.fn() }));
vi.mock("@lingui/react/macro", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/query/rpc", () => {
  const rpc = { cloudComputers };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & {
    size?: string;
    variant?: string;
  }) => <button {...props} />,
  OptionSelect: ({
    value,
    options,
    disabled,
    onValueChange,
    "data-testid": testId,
  }: {
    value: string;
    options: Array<{ value: string; label: string }>;
    disabled: boolean;
    onValueChange: (value: string) => void;
    "data-testid": string;
  }) => (
    <select
      aria-label={testId}
      data-testid={testId}
      disabled={disabled}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const cloud: CloudComputers = {
  available: ["standard", "large"],
  canManage: true,
  computers: [
    { id: "c1", scope: "team", botName: null, size: "standard", savedSize: "standard" },
    {
      id: "c2",
      scope: "dedicated",
      botName: "Researcher",
      size: "standard",
      savedSize: "standard",
    },
  ],
};
const key = spaceQueries(null, null).cloudComputers.list.queryKey();

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  notifyManager.setScheduler((callback) => callback());
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CloudComputerSizes />
      </QueryClientProvider>,
    );
  });
  await act(flush);
}
function size(id: string) {
  return host.querySelector<HTMLSelectElement>(`[data-testid="computer-size-${id}"]`);
}

function savedSize(id: string) {
  return client.getQueryData(key)?.computers.find((computer) => computer.id === id)?.savedSize;
}

async function chooseLarge() {
  const select = size("c1");
  if (!select) throw new Error("Missing team computer size");
  await act(async () => {
    select.value = "large";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(flush);
}

it("keeps a confirmed size when the cloud list cannot refresh", async () => {
  cloudComputers.list.mockResolvedValueOnce(cloud).mockRejectedValue(new Error("offline"));
  cloudComputers.setSize.mockResolvedValue({ ok: true });
  await render();
  expect(size("c1")?.value).toBe("standard");
  await chooseLarge();

  expect(cloudComputers.setSize).toHaveBeenCalledWith({ computerId: "c1", size: "large" });
  expect(cloudComputers.list).toHaveBeenCalledTimes(2);
  expect(size("c1")?.value).toBe("large");
  expect(size("c2")?.value).toBe("standard");
  expect(savedSize("c1")).toBe("large");
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Applies on its next start.");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("leaves the previous size and shows the error when the save fails", async () => {
  cloudComputers.list.mockResolvedValue(cloud);
  cloudComputers.setSize.mockRejectedValue(new Error("save failed"));
  await render();
  await chooseLarge();

  expect(cloudComputers.list).toHaveBeenCalledOnce();
  expect(size("c1")?.value).toBe("standard");
  expect(client.getQueryData(key)).toEqual(cloud);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not change computer size");
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("uses a successful refresh as the source of truth", async () => {
  const refreshed: CloudComputers = {
    ...cloud,
    computers: cloud.computers.filter((computer) => computer.id !== "c1"),
  };
  cloudComputers.list.mockResolvedValueOnce(cloud).mockResolvedValue(refreshed);
  cloudComputers.setSize.mockResolvedValue({ ok: true });
  await render();
  await chooseLarge();

  expect(cloudComputers.list).toHaveBeenCalledTimes(2);
  expect(client.getQueryData(key)).toEqual(refreshed);
  expect(size("c1")).toBeNull();
  expect(size("c2")?.value).toBe("standard");
});

it("keeps the effective size allowed by a newer list while remembering the confirmed choice", async () => {
  const saving = deferred<{ ok: true }>();
  const refreshed: CloudComputers = { ...cloud, available: ["standard"] };
  cloudComputers.list
    .mockResolvedValueOnce(cloud)
    .mockResolvedValueOnce(refreshed)
    .mockRejectedValue(new Error("offline"));
  cloudComputers.setSize.mockReturnValue(saving.promise);
  await render();
  await chooseLarge();
  await act(async () => client.invalidateQueries({ queryKey: key }));
  await act(async () => saving.resolve({ ok: true }));
  await act(flush);

  expect(cloudComputers.list).toHaveBeenCalledTimes(3);
  expect(client.getQueryData(key)?.available).toEqual(["standard"]);
  expect(savedSize("c1")).toBe("large");
  expect(size("c1")?.value).toBe("standard");
});
