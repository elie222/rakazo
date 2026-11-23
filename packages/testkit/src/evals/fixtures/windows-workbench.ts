import { readFileSync } from "node:fs";
import type { UserDeviceGateway } from "@rakazo/adapters";
import type { AgentDesktopRun } from "@rakazo/adapters/agent-desktop-host-screen";
import { createAgentDesktopHostScreen } from "@rakazo/adapters/agent-desktop-host-screen";

type HostComputerRequest = Parameters<UserDeviceGateway["request"]>[1];

export const INSPECTION_BADGE = "N7VX";

const workbenchApp = "workbench";
const title = "Work Order Desk";
const windowId = "w-orders";

type Control = { role: string; name: string; value?: string };
type Stage = "list" | "loading" | "form" | "saved";

export function createWindowsWorkbench(withBadge: boolean) {
  const badge = withBadge ? INSPECTION_BADGE : undefined;
  let stage: Stage = "list";
  let availableAt = 0;
  let summary = "";
  let assignee = "";
  let inspectionCode = "";
  let saved: { summary: string; assignee: string; inspectionCode?: string } | null = null;
  let toolCalls = 0;
  let screenshots = 0;
  let snapshot = 0;
  const refs = new Map<string, { stage: Stage; control: Control }>();

  function controls(): Control[] {
    if (stage === "loading" && Date.now() >= availableAt) stage = "form";
    const navigation = [
      { role: "button", name: "Dashboard" },
      { role: "button", name: "Work orders" },
      { role: "button", name: "Team directory" },
      { role: "button", name: "Settings" },
    ];
    switch (stage) {
      case "list":
      case "saved":
        return [
          ...navigation,
          { role: "button", name: "New work order" },
          ...(saved
            ? [{ role: "statictext", name: `Saved: ${saved.summary} (${saved.assignee})` }]
            : []),
          ...Array.from({ length: 12 }, (_, i) => ({
            role: "row",
            name: `Work order ${104 + i}. ${i % 2 ? "Awaiting review" : "Completed"}. Warehouse ${i + 1}.`,
          })),
        ];
      case "loading":
        return [...navigation, { role: "statictext", name: "Loading form" }];
      case "form":
        return [
          ...navigation,
          { role: "group", name: "New work order details" },
          { role: "textfield", name: "Summary", value: summary },
          { role: "textfield", name: "Assignee", value: assignee },
          ...(badge
            ? [
                { role: "image", name: "Inspection badge" },
                { role: "textfield", name: "Inspection code", value: inspectionCode },
              ]
            : []),
          { role: "button", name: "Save work order" },
          { role: "button", name: "Cancel" },
          { role: "statictext", name: "Summary and assignee are required." },
        ];
    }
  }

  function collect() {
    const rows = controls();
    const snapshot_id = `fixture${++snapshot}`;
    return {
      snapshot_id,
      rows: rows.map((control, i) => {
        const ref_id = `@${snapshot_id}:e${i + 1}`;
        refs.set(ref_id, { stage, control });
        return { ...control, ref_id };
      }),
    };
  }

  function screenshot() {
    screenshots++;
    controls();
    const image = stage === "form" ? (badge ? "badge" : "form") : "list";
    const data = readFileSync(new URL(`windows-workbench-${image}.png`, import.meta.url), "base64");
    return { data, format: "png", width: 1024, height: 640 };
  }

  const run: AgentDesktopRun = async ([command, ...args]) => {
    const ok = (data: unknown) => ({ ok: true, data });
    if (command === "list-windows")
      return ok([{ id: windowId, app_name: workbenchApp, title, pid: 1 }]);
    if (command === "screenshot") return ok(screenshot());
    if (command === "snapshot" || command === "find") {
      const { rows, snapshot_id } = collect();
      if (command === "snapshot")
        return ok({ snapshot_id, tree: { role: "window", name: title, children: rows } });
      const option = (key: string) => args.find((arg) => arg.startsWith(key))?.slice(key.length);
      const query = option("--text=")?.toLowerCase();
      const name = option("--name=");
      const role = option("--role=");
      const matches = rows.filter((control) =>
        query
          ? control.name.toLowerCase().includes(query)
          : control.name === name && control.role === role,
      );
      return ok({ snapshot_id, matches, total_matches: matches.length, truncated: false });
    }
    const [ref, value] = args.slice(args.indexOf("--") + 1);
    const found = ref ? refs.get(ref) : undefined;
    if (!found || found.stage !== stage)
      return { ok: false, error: { code: "STALE_REF", disposition: { retry: "safe" } } };
    const { name } = found.control;
    if (command === "click" && name === "New work order") {
      stage = "loading";
      availableAt = Date.now() + 400;
    } else if (command === "set-value" && stage === "form" && value !== undefined) {
      if (name === "Summary") summary = value;
      else if (name === "Assignee") assignee = value;
      else if (name === "Inspection code") inspectionCode = value;
      else return { ok: false, error: { code: "ACTION_FAILED" } };
    } else if (command === "click" && name === "Save work order" && summary && assignee) {
      if (badge && inspectionCode !== badge)
        return {
          ok: false,
          error: { code: "ACTION_FAILED", message: "Enter the code from the inspection badge." },
        };
      saved = { summary, assignee, ...(badge ? { inspectionCode } : {}) };
      stage = "saved";
    } else {
      return {
        ok: false,
        error: { code: "ACTION_FAILED", message: "That control cannot run this action." },
      };
    }
    return ok({});
  };

  const screen = createAgentDesktopHostScreen({ run, selfPid: -1 });
  const device = {
    deviceId: "fixture",
    name: "Fixture Windows",
    platform: "win32",
    screenOnly: true,
  };
  const gateway: UserDeviceGateway = {
    async connected(_owner, id) {
      return id === undefined || id === device.deviceId ? device : null;
    },
    async list() {
      return [{ ...device, bound: true, connected: true }];
    },
    async pairedSince() {
      return new Date(0);
    },
    async *request<T>(
      _owner: string,
      request: HostComputerRequest,
      signal: AbortSignal,
      deviceId?: string,
    ) {
      if (
        (deviceId !== undefined && deviceId !== device.deviceId) ||
        (request.method !== "screenObserve" && request.method !== "screenAct") ||
        request.app.toLowerCase() !== workbenchApp
      )
        throw new Error("The fixture only drives workbench.");
      toolCalls++;
      const scope = { botId: request.botId, signal };
      if (request.method === "screenObserve")
        yield (await screen.observe(scope, request.app, request)) as T;
      else yield (await screen.act(scope, request.app, request.actions, request)) as T;
    },
  };
  return { gateway, snapshot: () => ({ saved, toolCalls, screenshots }) };
}
