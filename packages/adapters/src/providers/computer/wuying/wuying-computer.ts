import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computer-provider-descriptor.js";

export const wuyingComputer: ComputerProviderDefinition = {
  capabilities: {
    terminal: false,
    inPlaceUpdate: false,
    nativeShell: true,
    runsOnUserMachine: false,
    screen: DEFAULT_COMPUTER_SCREEN,
    serverHomeMount: "never",
    serverOwnsStoredTeamHome: false,
    storedHomeIsBackup: true,
  },
  env: {
    wuyingAccessKeyId: { name: "WUYING_ACCESS_KEY_ID", required: true },
    wuyingAccessKeySecret: { name: "WUYING_ACCESS_KEY_SECRET", required: true },
    wuyingRegionId: { name: "WUYING_REGION_ID" },
    wuyingDesktopId: { name: "WUYING_DESKTOP_ID", required: true },
    wuyingEndUserId: { name: "WUYING_END_USER_ID", required: true },
    wuyingMcpUrl: { name: "WUYING_MCP_URL", required: true },
    wuyingMcpToken: { name: "WUYING_MCP_TOKEN", required: true },
  },
  settings: {
    displayName: "Wuying",
    perAccount: true,
    fields: [
      { key: "desktopId", option: "wuyingDesktopId", label: "Desktop ID", kind: "text" },
      { key: "endUserId", option: "wuyingEndUserId", label: "End user ID", kind: "text" },
      { key: "regionId", option: "wuyingRegionId", label: "Region", kind: "text" },
      { key: "accessKeyId", option: "wuyingAccessKeyId", label: "AccessKey ID", kind: "secret" },
      {
        key: "accessKeySecret",
        option: "wuyingAccessKeySecret",
        label: "AccessKey secret",
        kind: "secret",
      },
      { key: "mcpUrl", option: "wuyingMcpUrl", label: "MCP gateway URL", kind: "url" },
      {
        key: "mcpToken",
        option: "wuyingMcpToken",
        label: "MCP token",
        kind: "secret",
        destination: "mcpUrl",
      },
    ],
    validate(values) {
      if (values.regionId && !/^[a-z]+(-[a-z0-9]+)+$/.test(values.regionId))
        throw new Error("Invalid region");
    },
    async verifyConnection(values, signal) {
      const [{ WuyingOpenApi }, { WuyingMcpTools }] = await Promise.all([
        import("./wuying-openapi.js"),
        import("./wuying-sandbox.js"),
      ]);
      const settings = {
        accessKeyId: values.accessKeyId!,
        accessKeySecret: values.accessKeySecret!,
        regionId: values.regionId || "cn-hangzhou",
        desktopId: values.desktopId!,
        endUserId: values.endUserId!,
        mcpUrl: values.mcpUrl!,
        mcpToken: values.mcpToken!,
      };
      const control = new WuyingOpenApi(settings);
      const status = await control.desktopStatus(settings.desktopId, signal);
      if (status === null) throw new Error("Desktop unavailable");
      await control.authCode(settings.endUserId, signal);
      if (status === "Running")
        await new WuyingMcpTools({ url: settings.mcpUrl, token: settings.mcpToken }).call(
          "env_get",
          { name: "USERPROFILE" },
          signal,
        );
    },
  },
  async create(opts) {
    const { WuyingSandboxProvider } = await import("./wuying-sandbox.js");
    return WuyingSandboxProvider.fromOptions({
      accessKeyId: opts.wuyingAccessKeyId!,
      accessKeySecret: opts.wuyingAccessKeySecret!,
      regionId: opts.wuyingRegionId,
      desktopId: opts.wuyingDesktopId!,
      endUserId: opts.wuyingEndUserId!,
      mcpUrl: opts.wuyingMcpUrl!,
      mcpToken: opts.wuyingMcpToken!,
      referenceInUse: opts.referenceInUse,
    });
  },
};
