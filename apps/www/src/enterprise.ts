import { docsPath } from "./docs";
import { GITHUB_URL, SELF_HOST_GUIDE_PATH, SITE_URL } from "./site";

export const ENTERPRISE_PATH = "/enterprise/";
export const ENTERPRISE_H1 = "Rakazo for enterprise";
export const ENTERPRISE_TITLE = "Enterprise AI agents on your own infrastructure · Rakazo";
export const ENTERPRISE_DESCRIPTION =
  "Run Rakazo on your own infrastructure with SSO, SCIM, an audit log, encryption at rest, and approval rules. Open source under Apache-2.0.";
export const ENTERPRISE_LEAD =
  "AI teammates on infrastructure you control, with the sign-in, audit, and encryption controls a security review asks for.";
export const ENTERPRISE_CONTACT_EMAIL = "hello@rakazo.com";

export type EnterpriseFeatureKind =
  | "sso"
  | "scim"
  | "audit"
  | "encryption"
  | "approvals"
  | "infrastructure"
  | "models"
  | "spaces"
  | "source";

type EnterpriseFeature = {
  kind: EnterpriseFeatureKind;
  title: string;
  body: string;
  link: { label: string; href: string };
};

export const ENTERPRISE_FEATURES: readonly EnterpriseFeature[] = [
  {
    kind: "sso",
    title: "Single sign-on",
    body: "People sign in through your OpenID Connect provider, such as Okta, Microsoft Entra ID, or Google Workspace. Turn passwords off to make it the only way in.",
    link: {
      label: "Sign-in and accounts",
      href: `${docsPath("self-host-accounts")}#openid-connect-sso`,
    },
  },
  {
    kind: "scim",
    title: "Directory provisioning",
    body: "Your identity provider adds and removes people over SCIM 2.0. Turning someone off ends their sessions and cancels their runs at once.",
    link: {
      label: "Directory provisioning",
      href: `${docsPath("self-host-accounts")}#directory-provisioning-scim`,
    },
  },
  {
    kind: "audit",
    title: "Audit log",
    body: "Who did what: the actions bots took, who approved them, and which settings and credentials changed. Export it, or forward it to your SIEM.",
    link: { label: "Audit log", href: docsPath("self-host-audit-log") },
  },
  {
    kind: "encryption",
    title: "Encryption at rest",
    body: "Messages, memory, and files are encrypted with a separate key for each space. Keep the master key in AWS KMS, and rotate keys when you need to.",
    link: { label: "Storage and encryption", href: docsPath("self-host-storage") },
  },
  {
    kind: "approvals",
    title: "Approvals",
    body: "Bots ask before an action that changes something. Set allow and block rules for each space, and cap what a bot can spend.",
    link: { label: "Approvals", href: docsPath("approvals") },
  },
  {
    kind: "infrastructure",
    title: "Your infrastructure",
    body: "Run on Docker, or give every bot computer its own pod on your Kubernetes cluster. On a restricted network, install from your own mirror.",
    link: { label: "Production deployment", href: docsPath("self-host-production") },
  },
  {
    kind: "models",
    title: "Your models",
    body: "Connect your own provider keys, an OpenAI-compatible gateway, or a local model server. Content goes only to the provider you choose.",
    link: { label: "Models", href: docsPath("self-host-models") },
  },
  {
    kind: "spaces",
    title: "Spaces",
    body: "Keep teams and clients apart. Each space has its own bots, memory, computer, and credentials, and nothing crosses unless you allow it.",
    link: { label: "Spaces", href: docsPath("spaces") },
  },
  {
    kind: "source",
    title: "Open source",
    body: "Apache-2.0, with no seat fee to self-host. Your security team can read the code that runs your bots.",
    link: { label: "Source", href: GITHUB_URL },
  },
];

function absolute(href: string): string {
  return href.startsWith("/") ? `${SITE_URL}${href}` : href;
}

export const ENTERPRISE_MARKDOWN = `# ${ENTERPRISE_H1}

${ENTERPRISE_LEAD}

${ENTERPRISE_FEATURES.map(
  (feature) =>
    `- **${feature.title}:** ${feature.body} [${feature.link.label}](${absolute(feature.link.href)})`,
).join("\n")}

Email [${ENTERPRISE_CONTACT_EMAIL}](mailto:${ENTERPRISE_CONTACT_EMAIL}) to talk to us, or start with the [self-hosting guide](${absolute(SELF_HOST_GUIDE_PATH)}).
`;
