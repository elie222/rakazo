import { getLogger } from "@rakazo/logging";
import type { MessagingPlatform } from "../../../messaging/chat-sdk-surface.js";
import type { MessagingMountContext } from "../../../messaging/messaging-platform-descriptor.js";
import { defineMessagingPlatform } from "../../../messaging/messaging-platform-descriptor.js";
import { LazyPhotonAdapter } from "./lazy-adapter.js";

/**
 * iMessage through Photon (Spectrum Cloud). Without a webhook secret the
 * API process consumes Spectrum's outbound gRPC stream, so no public URL is
 * needed; other processes only send. With one, Spectrum posts signed
 * webhooks to /api/v1/messaging/webhook/photon and nothing streams.
 */
export const photonMessaging = defineMessagingPlatform({
  env: {
    photonProjectId: { name: "PHOTON_PROJECT_ID", required: true },
    photonProjectSecret: { name: "PHOTON_PROJECT_SECRET", required: true },
    photonWebhookSecret: { name: "PHOTON_WEBHOOK_SECRET" },
    /** Extra named Photon projects (PHOTON_PROJECT_ID_<NAME>), each with its own number. */
    photonProjects: { read: photonProjectsFromEnv },
  },
  mount(env, options) {
    return photonPlatform(
      "photon",
      {
        name: "",
        projectId: env.photonProjectId,
        projectSecret: env.photonProjectSecret,
        webhookSecret: env.photonWebhookSecret,
      },
      options,
    );
  },
  named(env, options) {
    // Two providers on one project would both consume its single stream.
    const projectIds = new Set<string>();
    if (options.defaultMounted && env.photonProjectId) projectIds.add(env.photonProjectId);
    const platforms: MessagingPlatform[] = [];
    for (const project of env.photonProjects ?? []) {
      const provider = `photon-${project.name}`;
      if (projectIds.has(project.projectId)) {
        getLogger().warn("skipping Photon project that reuses another provider's project", {
          provider,
        });
        continue;
      }
      projectIds.add(project.projectId);
      platforms.push(photonPlatform(provider, project, options));
    }
    return platforms;
  },
});

/** One extra Photon project, mounted as provider `photon-<name>`. */
export interface PhotonProjectCredentials {
  name: string;
  projectId: string;
  projectSecret: string;
  webhookSecret?: string | undefined;
}

const PHOTON_NAMED_PROJECT = /^PHOTON_PROJECT_ID_([A-Z0-9]+)$/;

/**
 * Extra Photon projects from PHOTON_PROJECT_ID_<NAME> plus
 * PHOTON_PROJECT_SECRET_<NAME> (and optionally PHOTON_WEBHOOK_SECRET_<NAME>).
 * Photon gives each person a different number in each project, so one person
 * can link a different Rakazo bot to each, as with named Telegram bots.
 * <NAME> is letters and digits only and becomes the provider id
 * `photon-<name>` (lowercased), which also names its webhook route.
 */
export function photonProjectsFromEnv(
  env: Record<string, string | undefined>,
): PhotonProjectCredentials[] {
  const projects: PhotonProjectCredentials[] = [];
  for (const [key, value] of Object.entries(env)) {
    const suffix = PHOTON_NAMED_PROJECT.exec(key)?.[1];
    if (!suffix) continue;
    const projectId = value?.trim();
    const projectSecret = env[`PHOTON_PROJECT_SECRET_${suffix}`]?.trim();
    if (!projectId || !projectSecret) continue;
    const webhookSecret = env[`PHOTON_WEBHOOK_SECRET_${suffix}`]?.trim() || undefined;
    projects.push({ name: suffix.toLowerCase(), projectId, projectSecret, webhookSecret });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

function photonPlatform(
  provider: string,
  project: PhotonProjectCredentials,
  options: MessagingMountContext,
): MessagingPlatform {
  return {
    provider,
    adapterName: "imessage",
    outbound: { markdown: true },
    capabilities: { direct: true, groups: false, receipt: "typing" },
    adapter: new LazyPhotonAdapter({
      projectId: project.projectId,
      projectSecret: project.projectSecret,
      webhookSecret: project.webhookSecret,
      pollInboundMessages: options.pollInboundMessages ?? false,
    }),
  };
}
