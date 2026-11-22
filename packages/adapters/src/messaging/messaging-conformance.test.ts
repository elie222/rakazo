import { describe, expect, it } from "vitest";
import type { MessagingEnvBinding } from "./messaging-platform-descriptor.js";
import {
  messagingEnvFromProcess,
  messagingPlatforms,
  messagingPlatformsFromEnv,
} from "./messaging-platforms.js";

interface Fixture {
  /** Fake values for every variable the platform reads, by name. */
  env: Record<string, string>;
  /** Variables that add one named mount, and the provider id it mounts as. */
  named?: { env: Record<string, string>; provider: string };
}

// Fake credentials: adapters are constructed offline, never called.
const fixtures = {
  sendblue: {
    env: {
      SENDBLUE_API_KEY_ID: "sb-key-id",
      SENDBLUE_API_SECRET: "sb-secret",
      SENDBLUE_SIGNING_SECRET: "sb-signing",
      SENDBLUE_PHONE_NUMBER: "+15550009999",
    },
  },
  slack: { env: { SLACK_BOT_TOKEN: "xoxb-fake", SLACK_SIGNING_SECRET: "slack-signing" } },
  teams: {
    env: {
      TEAMS_APP_ID: "00000000-0000-4000-8000-000000000001",
      TEAMS_APP_PASSWORD: "teams-secret",
      TEAMS_APP_TENANT_ID: "00000000-0000-4000-8000-000000000002",
    },
  },
  whatsapp: {
    env: {
      WHATSAPP_ACCESS_TOKEN: "wa-token",
      WHATSAPP_PHONE_NUMBER_ID: "wa-phone-id",
      WHATSAPP_APP_SECRET: "wa-app-secret",
      WHATSAPP_VERIFY_TOKEN: "wa-verify",
      WHATSAPP_API_URL: "https://graph.example.test",
      WHATSAPP_BOT_USERNAME: "wa-bot",
    },
  },
  telegram: {
    env: {
      TELEGRAM_BOT_TOKEN: "tg-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "tg-secret",
      TELEGRAM_GROUPS: "on",
    },
    named: {
      env: { TELEGRAM_BOT_TOKEN_WORK: "tg-work", TELEGRAM_WEBHOOK_SECRET_TOKEN_WORK: "tg-work-s" },
      provider: "telegram-work",
    },
  },
  lark: {
    env: {
      LARK_APP_ID: "cli-fake",
      LARK_APP_SECRET: "lark-secret",
      LARK_VERIFICATION_TOKEN: "lark-verify",
      LARK_ENCRYPT_KEY: "lark-encrypt",
      LARK_DOMAIN: "lark",
    },
  },
  photon: {
    env: {
      PHOTON_PROJECT_ID: "photon-project",
      PHOTON_PROJECT_SECRET: "photon-secret",
      PHOTON_WEBHOOK_SECRET: "photon-webhook",
    },
    named: {
      env: { PHOTON_PROJECT_ID_WORK: "photon-work", PHOTON_PROJECT_SECRET_WORK: "photon-work-s" },
      provider: "photon-work",
    },
  },
} satisfies Record<keyof typeof messagingPlatforms, Fixture>;

function mounted(env: Record<string, string | undefined>): string[] {
  return messagingPlatformsFromEnv(messagingEnvFromProcess(env)).map(
    (platform) => platform.provider,
  );
}

function variables(id: keyof typeof messagingPlatforms) {
  return Object.values(messagingPlatforms[id].env as Record<string, MessagingEnvBinding>).flatMap(
    (binding) => ("name" in binding ? [binding] : []),
  );
}

describe.each(Object.entries(fixtures) as [keyof typeof messagingPlatforms, Fixture][])(
  "%s messaging platform",
  (id, fixture) => {
    it("names exactly the variables its fixture sets", () => {
      expect(
        variables(id)
          .map((binding) => binding.name)
          .sort(),
      ).toEqual(Object.keys(fixture.env).sort());
    });

    it("mounts alone from its own variables, with values trimmed", () => {
      const padded = Object.fromEntries(
        Object.entries(fixture.env).map(([name, value]) => [name, ` ${value} `]),
      );
      const [platform, ...rest] = messagingPlatformsFromEnv(messagingEnvFromProcess(padded));
      expect(rest).toEqual([]);
      expect(platform?.provider).toBe(id);
      expect(platform?.adapter).toBeDefined();
      expect(typeof platform?.capabilities.direct).toBe("boolean");
    });

    it("stays off without any one required variable", () => {
      for (const binding of variables(id).filter((binding) => binding.required)) {
        expect(mounted({ ...fixture.env, [binding.name]: " " })).not.toContain(id);
      }
    });

    it("mounts with only its required variables", () => {
      const required = Object.fromEntries(
        variables(id)
          .filter((binding) => binding.required)
          .map((binding) => [binding.name, fixture.env[binding.name as keyof typeof fixture.env]]),
      );
      expect(mounted(required)).toEqual([id]);
    });

    if (fixture.named) {
      const named = fixture.named;
      it("mounts named copies beside the default one, or without it", () => {
        expect(mounted({ ...fixture.env, ...named.env })).toEqual([id, named.provider]);
        expect(mounted(named.env)).toEqual([named.provider]);
      });
    }
  },
);

describe("messaging platform registry", () => {
  it("reads each variable for one platform only", () => {
    const names = (Object.keys(messagingPlatforms) as (keyof typeof messagingPlatforms)[]).flatMap(
      (id) => variables(id).map((binding) => binding.name),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("mounts every platform in registry order when all are configured", () => {
    const env = Object.assign({}, ...Object.values(fixtures).map((fixture) => fixture.env));
    expect(mounted(env)).toEqual(Object.keys(messagingPlatforms));
  });
});
