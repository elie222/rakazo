import type { McpServerConfigInput } from "@rakazo/contracts";
import { z } from "zod";

const clients = z.record(
  z.string(),
  z.object({
    clientId: z.string().trim().min(1),
    clientSecret: z.string().min(1),
  }),
);

/** Deployment credentials configure bundled adapters, never arbitrary commands or URLs. */
export function deploymentApps(
  raw?: string,
): Array<{ id: string; name: string; config: McpServerConfigInput | null }> {
  let configured: z.infer<typeof clients> = {};
  if (raw?.trim()) {
    try {
      configured = clients.parse(JSON.parse(raw));
    } catch {
      throw new Error("Invalid DEPLOYMENT_APPS configuration");
    }
    if (Object.keys(configured).some((id) => id !== "drive"))
      throw new Error("Unknown deployment app");
  }
  const client = configured.drive;
  return [
    {
      id: "drive",
      name: "Google Drive",
      config: client
        ? {
            slug: "deployment-drive",
            name: "Google Drive",
            description: "",
            enabled: true,
            transport: "stdio",
            command: "/app/infra/compose/drive-mcp",
            args: [],
            env: { ACCESS_TOKEN: "{{oauth.access_token}}" },
            oauthClient: {
              ...client,
              authorizationServer: "https://accounts.google.com",
              scope:
                "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
              authorizationParams: "access_type=offline&prompt=consent",
            },
          }
        : null,
    },
  ];
}
