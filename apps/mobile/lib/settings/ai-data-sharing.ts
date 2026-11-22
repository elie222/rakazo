import type { AiConsentStatus, AiRecipient } from "@rakazo/contracts";

export function aiDataSharingPlaceholder(status: AiConsentStatus | null, loadFailed: boolean) {
  if (!status) return loadFailed ? "failed" : "loading";
  return status.recipients.length === 0 ? "empty" : null;
}

export function groupAiRecipients(recipients: AiRecipient[]) {
  return (["model", "voice", "memory"] as const)
    .map((use) => ({ use, recipients: recipients.filter((recipient) => recipient.use === use) }))
    .filter((group) => group.recipients.length > 0);
}

export function aiPrivacyLinks(recipients: AiRecipient[]) {
  const links = new Map<string, { name: string; url: string }>();
  for (const recipient of recipients) {
    if (!recipient.privacyUrl) continue;
    const key = JSON.stringify([recipient.name, recipient.privacyUrl]);
    links.set(key, { name: recipient.name, url: recipient.privacyUrl });
  }
  return [...links.values()];
}
