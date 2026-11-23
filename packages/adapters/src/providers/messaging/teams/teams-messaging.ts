import { boundInboundMarkdown } from "../../../messaging/chat-sdk-surface.js";
import { lazyChatAdapter } from "../../../messaging/lazy-chat-adapter.js";
import { defineMessagingPlatform } from "../../../messaging/messaging-platform-descriptor.js";

/**
 * Single-tenant credentials keep enterprise installations scoped to their tenant.
 * Channels and group chats stay disabled until their room semantics are mapped.
 */
export const teamsMessaging = defineMessagingPlatform({
  env: {
    teamsAppId: { name: "TEAMS_APP_ID", required: true },
    teamsAppPassword: { name: "TEAMS_APP_PASSWORD", required: true },
    teamsAppTenantId: { name: "TEAMS_APP_TENANT_ID", required: true },
  },
  mount(env) {
    const config = {
      appId: env.teamsAppId,
      appPassword: env.teamsAppPassword,
      appTenantId: env.teamsAppTenantId,
      appType: "SingleTenant" as const,
    };
    return {
      provider: "teams",
      capabilities: { direct: true, groups: false, receipt: "typing" },
      adapter: lazyChatAdapter("teams", async () => {
        const { createTeamsAdapter } = await import("@chat-adapter/teams");
        const adapter = createTeamsAdapter(config);
        boundInboundMarkdown(adapter);
        return adapter;
      }),
    };
  },
});
